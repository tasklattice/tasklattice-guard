// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { PostgresValidationCredentialLeaseStore } from "./validation-credential-leases.js";
import { decryptModelCredential, encryptModelCredential } from "./secret-crypto.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("durable candidate credential leases", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let first: PostgresValidationCredentialLeaseStore;
  let second: PostgresValidationCredentialLeaseStore;
  const secret = "synthetic-encryption-root";
  const provider = { id: "candidate-provider", credentialCiphertext: encryptModelCredential("synthetic-candidate-key", secret) };
  const session = { runnerId: "candidate-runner", bootId: "candidate-boot", sessionId: "candidate-session", poolId: "candidate-pool" };
  beforeAll(async () => {
    database = await createTestDatabase(url!, "candidate_credential_leases");
    first = new PostgresValidationCredentialLeaseStore(database.db);
    second = new PostgresValidationCredentialLeaseStore(database.db);
    await database.pool.query("INSERT INTO model_provider(id,name,kind,base_url,credential_ciphertext) VALUES ($1,'Candidate','custom-openai-compatible','https://invalid.example',$2)", [provider.id, provider.credentialCiphertext]);
    await database.pool.query("INSERT INTO project_group(id,name) VALUES ('candidate-group','Candidate'),('other-group','Other')");
    await database.pool.query("INSERT INTO runner_pool(id,name,group_id,project_id) VALUES ('candidate-pool','Candidate','candidate-group','projectA'),('other-pool','Other','other-group','projectB')");
    await database.pool.query("INSERT INTO runner_pool_lease_epoch(pool_id) VALUES ('candidate-pool'),('other-pool')");
  }, 30000);
  afterAll(async () => { await database?.drop(); });
  beforeEach(async () => {
    await database.pool.query("DELETE FROM model_validation_credential_lease; DELETE FROM runner_instance; DELETE FROM runner_control_session; UPDATE runner_pool SET group_id='candidate-group' WHERE id='candidate-pool'; UPDATE runner_pool_lease_epoch SET epoch=0,draining=false");
    await database.pool.query("UPDATE model_provider SET credential_ciphertext=$1 WHERE id=$2", [provider.credentialCiphertext, provider.id]);
  });
  const create = async (id = "candidate") => { expect(await first.create(id, provider)).toBe(true); return id; };
  const bind = async (id = "candidate") => { expect(await first.bind(id, "candidate-pool")).toBe(true); };

  it("redeems and revokes across independent Controller stores without plaintext persistence", async () => {
    await create(); await bind();
    const row = await second.resolve("candidate", [provider.id], "candidate-pool");
    expect(decryptModelCredential(row!.credentialCiphertext, secret)).toBe("synthetic-candidate-key");
    expect(JSON.stringify((await database.pool.query("SELECT * FROM model_validation_credential_lease")).rows)).not.toContain("synthetic-candidate-key");
    await second.revoke("candidate");
    expect(await first.resolve("candidate", [provider.id], "candidate-pool")).toBeNull();
  });

  it("separates unbound legacy authority from bound pool authority and exact refs", async () => {
    await create();
    expect(await first.resolve("candidate", [provider.id], "candidate-pool")).toBeNull();
    expect(await first.resolve("candidate", [provider.id])).not.toBeNull();
    await bind();
    expect(await first.resolve("candidate", [provider.id])).toBeNull();
    expect(await first.resolve("candidate", [provider.id], "other-pool")).toBeNull();
    for (const refs of [[], ["unknown"], [provider.id, "unknown"]]) expect(await first.resolve("candidate", refs, "candidate-pool")).toBeNull();
    expect(await second.resolve("candidate", [provider.id, provider.id], "candidate-pool")).not.toBeNull();
    expect(await first.resolve("missing", [provider.id], "candidate-pool")).toBeNull();
  });

  it("binds exactly once even when two Controllers compete", async () => {
    await create();
    const results = await Promise.all([first.bind("candidate", "candidate-pool"), second.bind("candidate", "other-pool")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const pool = results[0] ? "candidate-pool" : "other-pool";
    expect(await second.bind("candidate", pool)).toBe(true);
    expect(await first.resolve("candidate", [provider.id], pool)).not.toBeNull();
  });

  it.each(["epoch", "group", "draining"])("denies redemption and rebinding after %s changes", async change => {
    await create(); await bind();
    if (change === "epoch") await database.pool.query("UPDATE runner_pool_lease_epoch SET epoch=1 WHERE pool_id='candidate-pool'");
    if (change === "group") await database.pool.query("UPDATE runner_pool SET group_id='other-group' WHERE id='candidate-pool'");
    if (change === "draining") await database.pool.query("UPDATE runner_pool_lease_epoch SET draining=true WHERE pool_id='candidate-pool'");
    expect(await first.resolve("candidate", [provider.id], "candidate-pool")).toBeNull();
    expect(await second.bind("candidate", "candidate-pool")).toBe(false);
  });

  it("denies missing pools and preserves the exact encrypted candidate after Provider rotation", async () => {
    await create();
    expect(await first.bind("candidate", "missing-pool")).toBe(false);
    await bind();
    await database.pool.query("UPDATE model_provider SET credential_ciphertext=$1 WHERE id=$2", [encryptModelCredential("rotated-key", secret), provider.id]);
    expect((await second.resolve("candidate", [provider.id], "candidate-pool"))!.credentialCiphertext).toBe(provider.credentialCiphertext);
  });

  it("uses database expiry and prunes expired leases before capacity checks", async () => {
    await create();
    await database.pool.query("UPDATE model_validation_credential_lease SET created_at=clock_timestamp()-interval '96 seconds', expires_at=clock_timestamp()-interval '1 second'");
    expect(await first.resolve("candidate", [provider.id])).toBeNull();
    expect(await first.bind("candidate", "candidate-pool")).toBe(false);
    expect(await second.create("fresh", provider)).toBe(true);
    expect((await database.pool.query("SELECT id FROM model_validation_credential_lease")).rows).toEqual([{ id: "fresh" }]);
  });

  it("caps concurrent issuers at64 globally without relying on per-process memory", async () => {
    const results = await Promise.all(Array.from({ length: 66 }, (_, index) => (index % 2 ? first : second).create(`candidate-${index}`, provider)));
    expect(results.filter(Boolean)).toHaveLength(64);
    expect(Number((await database.pool.query("SELECT count(*) FROM model_validation_credential_lease")).rows[0].count)).toBe(64);
  });

  it("binds to the dispatched session and denies a replaced or disconnected stream", async () => {
    await create();
    expect(await first.bind("candidate", "candidate-pool", session)).toBe(false);
    await database.pool.query("INSERT INTO runner_control_session(id,runner_id,boot_id,pool_id) VALUES ($1,$2,$3,$4)", [session.sessionId, session.runnerId, session.bootId, session.poolId]);
    await database.pool.query("INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,status,max_concurrency,control_session_id) VALUES ($1,$2,$3,'test','test','ready',1,$4)", [session.runnerId, session.bootId, session.poolId, session.sessionId]);
    expect(await second.bind("candidate", "candidate-pool", session)).toBe(true);
    expect(await first.bind("candidate", "candidate-pool")).toBe(false);
    expect(await first.resolve("candidate", [provider.id], "candidate-pool")).not.toBeNull();
    await database.pool.query("UPDATE runner_control_session SET disconnected_at=clock_timestamp() WHERE id=$1", [session.sessionId]);
    expect(await first.resolve("candidate", [provider.id], "candidate-pool")).toBeNull();
    await database.pool.query("UPDATE runner_control_session SET disconnected_at=NULL WHERE id=$1", [session.sessionId]);
    await database.pool.query("INSERT INTO runner_control_session(id,runner_id,boot_id,pool_id) VALUES ('replacement-session',$1,$2,$3);", [session.runnerId, session.bootId, session.poolId]);
    await database.pool.query("UPDATE runner_instance SET control_session_id='replacement-session' WHERE runner_id=$1", [session.runnerId]);
    expect(await second.resolve("candidate", [provider.id], "candidate-pool")).toBeNull();
    expect(await second.bind("candidate", "candidate-pool", { ...session, sessionId: "replacement-session" })).toBe(false);
  });
});
