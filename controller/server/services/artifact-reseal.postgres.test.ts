// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSync } from "@grpc/proto-loader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { artifactFromWire } from "../control-channel/protocol-codec.js";
import { artifactContent, artifactContentDigest, verifyArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import type { Artifact__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/Artifact.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const protoPath = resolve("../proto/tasklattice/guard/control/v1/runner_control.proto");

function fixtureContent(name: string): ArtifactContent {
  const desired = loadSync(protoPath, { includeDirs: [resolve("../proto/tasklattice/guard/control/v1")], longs: String, enums: String, defaults: true, oneofs: true })["tasklattice.guard.control.v1.DesiredState"]!;
  if (!("deserialize" in desired)) throw new Error("Missing DesiredState type");
  const state = desired.deserialize(Buffer.from(readFileSync(resolve(`../tests/fixtures/artifacts/${name}/desired-state.pb.b64`), "utf8"), "base64"));
  return artifactContent(artifactFromWire(state.artifacts[0] as Artifact__Output) as unknown as ArtifactContent);
}

describe.skipIf(!url)("Artifact re-sealing in PostgreSQL", () => {
  const keys = mkdtempSync(join(tmpdir(), "guard-reseal-"));
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(join(keys, "private.pem"), pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;

  beforeAll(async () => {
    database = await createTestDatabase(url!, "guard_reseal");
    service = new ControlPlaneService(database.db, loadConfig({
      NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!, CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: join(keys, "private.pem"), CONTROLLER_PROTO_PATH: protoPath,
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    }));
  });
  afterAll(async () => { await database?.drop(); rmSync(keys, { recursive: true, force: true }); });

  it("re-signs legacy digests, normalizes stored content and drops generation-only duplicates", async () => {
    const content = fixtureContent("default-local-v1");
    // Earlier rows can carry domain-only fields the transport never delivered.
    const legacyPlan = { ...structuredClone(content.plan), display_note: "not part of the Runner contract" };
    const row = (id: string, generation: number) => ({ ...content, plan: legacyPlan, id, generation, checksum: `legacy-${id}`, signature: "legacy" });
    const { pool } = database;
    await pool.query("INSERT INTO controller_state (id, desired_generation) VALUES ('singleton', 5)");
    await pool.query("INSERT INTO guardrail (id, name, draft_config, status) VALUES ($1, 'Fixture', '{}', 'active')", [content.guardrailId]);
    for (const item of [row("kept", 1), row("duplicate", 2)]) {
      await pool.query(`INSERT INTO guardrail_artifact (id, guardrail_id, guardrail_version, generation, compiler_version, nemo_version, runtime_profile, plan, config_yaml, colang_content, prompts, action_bindings, dependency_manifest, checksum, signature, content_digest_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1)`, [item.id, item.guardrailId, item.guardrailVersion, item.generation, item.compilerVersion, item.nemoVersion, item.runtimeProfile,
        JSON.stringify(item.plan), item.configYaml, item.colangContent, JSON.stringify(item.prompts), JSON.stringify(item.actionBindings), JSON.stringify(item.dependencyManifest), item.checksum, item.signature]);
    }
    await pool.query("INSERT INTO guardrail_version (guardrail_id, version, generation, status, runtime_profile, plan, artifact_id) VALUES ($1, $2, 1, 'ready', 'auto', '{}', 'kept')", [content.guardrailId, content.guardrailVersion]);

    expect(await service.resealArtifacts()).toBe(2);

    const stored = (await pool.query("SELECT * FROM guardrail_artifact")).rows;
    expect(stored.map(item => item.id)).toEqual(["kept"]);
    const digest = artifactContentDigest(content);
    expect(stored[0]).toMatchObject({ checksum: digest, content_digest_version: 2, generation: "1" });
    expect(stored[0].plan).toEqual(content.plan);
    expect(verifyArtifactDigest(digest, stored[0].signature, publicKey)).toBe(true);
    expect((await pool.query("SELECT desired_generation FROM controller_state")).rows[0].desired_generation).toBe("6");
    expect((await pool.query("SELECT kind FROM controller_outbox")).rows).toEqual([{ kind: "runner.desired_state_changed" }]);
    expect(await service.resealArtifacts()).toBe(0);
  });
});
