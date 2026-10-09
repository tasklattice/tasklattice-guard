#!/usr/bin/env node
/**
 * Opt-in end-to-end Guardrail promotion regression across two isolated
 * deployments started by scripts/promotion-two-stacks.sh: UAT authors, tests,
 * publishes and exports; PROD (authoring disabled, no Policy Library) imports,
 * verifies, routes through an approved change and serves real traffic.
 *
 *   scripts/promotion-two-stacks.sh start
 *   eval "$(scripts/promotion-two-stacks.sh env)"
 *   cd controller && node --import tsx ../scripts/regress_guardrail_promotion.mjs
 *
 * Real HTTP, PostgreSQL, Runner validation, signing, import, Runner load
 * checks, Router approval and runtime evaluation. Model-free content only.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { artifactContentDigest } from "../controller/server/domain/artifact-content.ts";
import { buildPackage, parsePackage } from "../controller/server/domain/guardrail-package.ts";
import { readZip, writeZip } from "../controller/server/domain/zip.ts";

const { Pool } = createRequire(new URL("../controller/package.json", import.meta.url))("pg");
const env = key => { assert(process.env[key], `Set ${key} (eval "$(scripts/promotion-two-stacks.sh env)").`); return process.env[key]; };
const work = env("GUARD_PROMOTION_WORKDIR");
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const report = (stage, detail = {}) => console.log(JSON.stringify({ runId, stage, ...detail }));
const LIMITS = { maxEntries: 512, maxEntryBytes: 16 << 20, maxTotalBytes: 64 << 20 };

class Stack {
  constructor(name, base, runner) {
    this.name = name;
    this.base = new URL(base);
    this.runner = new URL(runner);
    assert(["127.0.0.1", "localhost"].includes(this.base.hostname), "Use isolated loopback deployments.");
    this.origin = this.base.origin;
    this.cookie = "";
  }
  async signIn(email, password) {
    const response = await fetch(new URL("/api/auth/sign-in/email", this.base), { method: "POST",
      headers: { "content-type": "application/json", origin: this.origin }, body: JSON.stringify({ email, password }) });
    assert.equal(response.status, 200, `${this.name} sign-in: ${await response.text()}`);
    this.cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    return this;
  }
  /** JSON (or form) request; asserts the expected status (or one of several) and returns the parsed body. */
  async call(path, { method, body, form, expected = 200, binary = false } = {}) {
    const response = await fetch(new URL(path, this.base), {
      method: method ?? (body === undefined && !form ? "GET" : "POST"),
      headers: { origin: this.origin, cookie: this.cookie, ...(form ? {} : { "content-type": "application/json" }) },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(120_000),
    });
    const payload = binary && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json().catch(() => null);
    assert([expected].flat().includes(response.status), `${this.name} ${path}: ${response.status} ${binary ? "" : JSON.stringify(payload)}`);
    return payload;
  }
  async evaluate(path, body, headers) {
    const response = await fetch(new URL(path, this.runner), { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  upload(bytes, name = "package.guardrail.zip", expected = 201) {
    const form = new FormData();
    form.append("package", new Blob([bytes], { type: "application/zip" }), name);
    return this.call("/api/v1/guardrail-packages", { form, expected });
  }
}

async function until(label, read, ready, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value).slice(0, 500)}`);
    await delay(1_000);
  }
}

const versionFiles = (bytes, version) => new Map([...readZip(bytes, LIMITS)].filter(([path]) => path.startsWith(`versions/${version}/`)));
const signer = (keyFile, keyId) => manifest => [{ keyId, algorithm: "ed25519", signature: sign(null, manifest, createPrivateKey(readFileSync(join(work, "keys", keyFile)))).toString("base64") }];
/** Re-issue parsed versions under another source, Guardrail or content, properly signed. */
function reissue(parsed, { source = parsed.manifest.source, guardrail = parsed.manifest.guardrail, sign: signWith, mutate = content => content }) {
  return buildPackage({ source, guardrail, recommendedVersion: parsed.manifest.recommendedVersion, exportedAt: new Date(), sign: signWith,
    versions: parsed.versions.map(item => {
      const content = mutate({ ...item.content, guardrailId: guardrail.id, plan: { ...item.content.plan, guardrail_id: guardrail.id } });
      return { content, inspection: item.inspection, evidence: { ...item.evidence, guardrailId: guardrail.id, source, contentDigest: artifactContentDigest(content) } };
    }) });
}

const uat = await new Stack("UAT", env("GUARD_PROMOTION_UAT_URL"), env("GUARD_PROMOTION_UAT_RUNNER_URL")).signIn(env("GUARD_PROMOTION_UAT_EMAIL"), env("GUARD_PROMOTION_PASSWORD"));
const prod = await new Stack("PROD", env("GUARD_PROMOTION_PROD_URL"), env("GUARD_PROMOTION_PROD_RUNNER_URL")).signIn(env("GUARD_PROMOTION_PROD_EMAIL"), env("GUARD_PROMOTION_PASSWORD"));
const uatDb = new Pool({ connectionString: env("GUARD_PROMOTION_UAT_DB") });
const prodDb = new Pool({ connectionString: env("GUARD_PROMOTION_PROD_DB") });
const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

// ---------------------------------------------------------------- UAT authoring
const phases = ["input", "output"];
const marker = `PROMOTION_MARKER_${runId.slice(11, 19).replaceAll("-", "")}`;
const policyDraft = (blocked) => ({ guardrail_category: "content_safety", colang_version: "2.x",
  sources: [{ path: "checks.co", content: phases.map(phase => `flow promotion_${phase} $text\n  if $text == "${blocked}"\n    $r = await GuardRecordPolicyAction(flow_name="promotion_${phase}", safe=False, text=$text)\n  else\n    $r = await GuardRecordPolicyAction(flow_name="promotion_${phase}", safe=True, text=$text)\n`).join("\n") }],
  rail_bindings: phases.map(phase => ({ rail_type: phase, flow_name: `promotion_${phase}`, execution_mode: "detect", on_unsafe: "block", risk_severity: "high" })),
  action_references: [{ name: "GuardRecordPolicyAction", version: "1.0.0" }], execution_contract: [["output_delivery", "full_buffered"]],
  test_cases: phases.flatMap(phase => [[blocked, "block"], ["ordinary request", "allow"]].map(([content, expected], index) => ({
    id: `${phase}-${index}`, name: `${phase} ${expected}`, rail_type: phase, content, expected_decision: expected,
    covered_rule_ids: [`flow/${phase}/promotion_${phase}`], case_type: `${phase}_rail`, target_source: phase === "output" ? "model_output" : "user_input" }))) });

const policy = await uat.call("/api/v1/policies", { expected: 201, body: { name: `Promotion marker ${runId}`, description: "Model-free promotion regression", owner: "regression", draft: policyDraft(marker) } });
async function publishPolicy(expectedVersion) {
  await uat.call(`/api/v1/policies/${policy.id}/test-runs`, { body: {}, expected: 202 });
  const run = await until("Policy test", () => uat.call(`/api/v1/policies/${policy.id}/test-runs/latest`), value => ["passed", "failed"].includes(value.status));
  assert.equal(run.status, "passed", JSON.stringify(run));
  const { implementation_detail: detail } = await uat.call(`/api/v1/policies/${policy.id}`);
  const published = await uat.call(`/api/v1/policies/${policy.id}/publish`, { body: { expectedDraftRevision: detail.draft_revision }, expected: 201 });
  assert.equal(published.version, expectedVersion);
}
await publishPolicy("1");
report("uat-policy-published", { policyId: policy.id, marker });

const binding = { policyId: policy.id, policyVersion: "1", enabledRails: phases, enabledRuleIds: phases.map(phase => `flow/${phase}/promotion_${phase}`) };
const network = (rules) => ({ policyId: "local-network-addresses", policyVersion: "2.0.0", enabledRails: phases, enabledRuleIds: rules });
const draftConfig = (rules) => ({ allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [network(rules), binding] });
const guardrail = await uat.call("/api/v1/guardrails", { expected: 201, body: { name: `Bank assistant ${runId}`, runtimeProfile: "auto", draftConfig: draftConfig(["pattern/ipv4", "pattern/ipv6", "pattern/url"]) } });
const guardrailPath = `/api/v1/guardrails/${guardrail.id}`;

async function testAndPublish(draftRevision) {
  const requested = await uat.call(`${guardrailPath}/test-runs`, { body: {}, expected: 202 });
  const run = await until("Guardrail test", () => uat.call(`/api/v1/test-runs/${requested.id}`), value => ["passed", "failed"].includes(value.status));
  assert.equal(run.status, "passed", JSON.stringify({ reason: run.failureReason, failed: run.results.filter(item => !item.passed) }));
  assert.match(run.candidateDigest, /^[0-9a-f]{64}$/, "A passed run keeps the digest of the exact Artifact it tested.");
  assert(run.results.every(item => item.modelInvocations === 0), "This regression must not call models.");
  const published = await uat.call(`${guardrailPath}/publish`, { body: { expectedDraftRevision: draftRevision }, expected: 201 });
  assert.equal(published.status, "ready", "Publication is synchronous: nothing is compiled again.");
  const detail = await uat.call(guardrailPath);
  const version = detail.versions.find(item => item.version === published.version);
  assert.equal(version.artifact.checksum, run.candidateDigest, "The published Artifact is exactly the tested candidate.");
  assert.equal(version.validationRunId, run.id);
  report("uat-published", { version: published.version, digest: version.artifact.checksum, cases: run.metrics.total });
  return published.version;
}
const v1 = await testAndPublish(1);
await uat.call(guardrailPath, { method: "PATCH", body: { draftConfig: draftConfig(["pattern/ipv4", "pattern/ipv6"]), expectedDraftRevision: 1 } });
const v2 = await testAndPublish(2);

const both = await uat.call(`${guardrailPath}/package?versions=${v1},${v2}`, { binary: true });
const latestOnly = await uat.call(`${guardrailPath}/package?versions=${v2}`, { binary: true });
writeFileSync(join(work, "packages", `${guardrail.id}-v1-v2.guardrail.zip`), both);
writeFileSync(join(work, "packages", `${guardrail.id}-v2.guardrail.zip`), latestOnly);
const exported = parsePackage(both);
assert.deepEqual(exported.versions.map(item => item.version), [v1, v2]);
assert.equal(exported.manifest.source.id, "bank-uat");
report("uat-exported", { versions: [v1, v2], bytes: both.length, recommended: exported.manifest.recommendedVersion });

// A newer Library Policy with the same ID never changes an already released version.
await uat.call(`/api/v1/policies/${policy.id}`, { method: "PATCH", body: { draft: policyDraft(`${marker}_V2`) } });
await publishPolicy("2");
const reexported = await uat.call(`${guardrailPath}/package?versions=${v2}`, { binary: true });
assert.deepEqual(versionFiles(reexported, v2), versionFiles(both, v2), "Re-exporting a version is byte-identical after the Library changed.");
report("uat-export-stable-after-library-change");

// ---------------------------------------------------------------- PROD receiving
assert.deepEqual(await prod.call("/api/v1/deployment/capabilities"), { authoringEnabled: false, packageExport: { available: false, sourceId: null }, packageImport: { available: true } });
assert.equal((await prod.call("/api/v1/policies", { expected: 403 })).error.code, "authoring_disabled");
assert.equal((await prod.call("/api/v1/guardrails", { body: { name: "x", runtimeProfile: "auto", draftConfig: draftConfig([]) }, expected: 403 })).error.code, "authoring_disabled");
// A rerun against the same PROD keeps the baseline an earlier run set.
const freshProd = (await prod.call("/api/v1/system/baseline")).version === null;
const coldStatus = await (await fetch(new URL("/api/v1/system/status", prod.base))).json();
if (freshProd) {
  assert.equal(coldStatus.components.basicProtection.status, "unconfigured");
  assert(coldStatus.reasons.includes("baseline_not_configured"));
}
assert.equal(await count(prodDb, "SELECT count(*) AS n FROM policy_record"), 0);
report("prod-cold-start", { status: coldStatus.status, reasons: coldStatus.reasons });

const preview = await prod.upload(both);
assert.deepEqual(preview.blockers, []);
assert.deepEqual(preview.versions.map(item => [item.version, item.state]), [[v1, "new"], [v2, "new"]]);
for (const item of preview.versions) assert.equal(item.environment?.status, "compatible", `PROD Runner load check: ${JSON.stringify(item.environment)}`);
const imported = await prod.call(`/api/v1/guardrail-packages/${preview.packageId}/imports`, { body: {}, expected: 201 });
assert.deepEqual(imported, { guardrailId: guardrail.id, imported: [v1, v2], existing: [], latestVersion: exported.manifest.recommendedVersion });
const again = await prod.upload(both);
assert.deepEqual(again.versions.map(item => item.state), ["existing", "existing"]);
assert.deepEqual((await prod.call(`/api/v1/guardrail-packages/${again.packageId}/imports`, { body: {}, expected: 201 })).imported, []);
assert.deepEqual((await prod.upload(latestOnly)).versions.map(item => item.state), ["existing"]);
report("prod-imported", imported);

const digests = async db => (await db.query("SELECT guardrail_version AS version, checksum, signature, generation FROM guardrail_artifact WHERE guardrail_id = $1 ORDER BY 1", [guardrail.id])).rows;
const [uatArtifacts, prodArtifacts] = [await digests(uatDb), await digests(prodDb)];
assert.deepEqual(prodArtifacts.map(row => [row.version, row.checksum]), uatArtifacts.map(row => [row.version, row.checksum]), "Content digests are identical across environments.");
prodArtifacts.forEach((row, index) => assert.notEqual(row.signature, uatArtifacts[index].signature, "Each environment signs with its own key."));
assert.equal(await count(prodDb, "SELECT count(*) AS n FROM guardrail_validation_run"), 0, "Production never re-tests.");
assert.equal(await count(prodDb, "SELECT count(*) AS n FROM controller_outbox WHERE kind = 'guardrail.validation_requested'"), 0);
report("prod-digests-match", { digests: prodArtifacts.map(row => row.checksum.slice(0, 12)) });

// The load check that runs right after import lets the default pool hold the
// versions, so they can be tried (Playground) before any Router serves them.
await until("PROD records a compatible load check for both imported versions", async () => (await prod.call(guardrailPath)).versions,
  versions => [v1, v2].every(version => versions.find(item => item.version === version)?.environmentCheck?.status === "compatible"));
const preloadGeneration = (await (await fetch(new URL("/api/v1/system/status", prod.base))).json()).desiredGeneration;
await until("PROD Runner preloads the checked versions", async () => (await fetch(new URL("/health/ready", prod.runner))).json(), value => value.applied_generation >= preloadGeneration);
const preloaded = await prod.evaluate(`/internal/v1/guardrails/${guardrail.id}/evaluate`, { guardrail_version: v2, phase: "input", texts: ["hello"] },
  { authorization: `Bearer ${env("GUARD_PROMOTION_RUNNER_TOKEN")}` });
assert.equal(preloaded.status, 200, `A checked imported version is preloaded before routing: ${JSON.stringify(preloaded)}`);
// Playground talks to released versions here; only draft previews are authoring.
assert.equal((await prod.call("/api/v1/playground/models")).items !== undefined, true);
assert.equal((await prod.call(`/api/v1/playground/guardrails/${guardrail.id}/draft-previews`, { body: {}, expected: 403 })).error.code, "authoring_disabled");
const playground = await prod.call(`/api/v1/playground/guardrails/${guardrail.id}/interactions`, { body: { guardrail_version: v2, model_id: "any", message: "hello" }, expected: [200, 503] });
assert.notEqual(playground.error?.code, "authoring_disabled", "Released versions can be tried in Playground.");
report("prod-preloaded-for-playground", { versions: [v1, v2], playground: playground.error?.code ?? "ok" });

// ---------------------------------------------------------------- PROD routing through an approved change
await prod.call("/api/auth/admin/create-user", { body: { email: `approver-${runId}@prod.local`, password: env("GUARD_PROMOTION_PASSWORD"), name: "Approver", role: "admin" } });
const approver = await new Stack("PROD approver", env("GUARD_PROMOTION_PROD_URL"), env("GUARD_PROMOTION_PROD_RUNNER_URL")).signIn(`approver-${runId}@prod.local`, env("GUARD_PROMOTION_PASSWORD"));
const endpoint = await prod.call("/api/v1/endpoints", { expected: 201, body: { name: `Bank gateway ${runId}`, adapter: "generic-http-guard" } });
const router = await prod.call("/api/v1/routers", { expected: 201, body: { name: `Bank traffic ${runId}`, endpointIds: [endpoint.id], draft: { routes: [{
  id: "fallback", name: "Fallback", kind: "fallback", enabled: true, selector: { expression: { combinator: "and", conditions: [] } },
  targets: [{ id: "target", guardrailId: guardrail.id, guardrailVersion: v2, weightBps: 10_000 }] }] } } });
const review = await prod.call(`/api/v1/routers/${router.id}/publication-preview`, { body: { expectedDraftRevision: router.draftRevision } });
const change = await prod.call(`/api/v1/routers/${router.id}/change-requests`, { expected: 201, body: {
  expectedDraftRevision: router.draftRevision, reviewedSnapshot: review.snapshot, reviewedEndpointIds: review.endpointIds, reason: "CR-1001 promote UAT release", ticket: "CR-1001" } });
const checked = (await prod.call(guardrailPath)).versions.find(item => item.version === v2).environmentCheck;
assert.equal(checked.status, "compatible", "Submitting re-checked the imported version on this environment's Runners.");
await approver.call(`/api/v1/routers/${router.id}/change-requests/${change.id}/approve`, { body: { note: "Approved per CR-1001" }, expected: 202 });
// Status answers 503 while Runners converge; read it whatever the code.
const systemStatus = async stack => (await fetch(new URL("/api/v1/system/status", stack.base))).json();
const target = (await systemStatus(prod)).desiredGeneration;
await until("PROD Runner applies the routed release", async () => (await fetch(new URL("/health/ready", prod.runner))).json(), value => value.ready && value.applied_generation >= target);
report("prod-routed", { routerId: router.id, changeId: change.id, endpointId: endpoint.id });

const runtime = (phase, text) => prod.evaluate(`/runtime/v1/endpoints/${endpoint.id}/guardrails/evaluate`, { phase, texts: [text] }, { "x-api-key": endpoint.credential });
for (const phase of phases) {
  const benign = await runtime(phase, "What are your opening hours?");
  assert.equal(benign.status, 200, JSON.stringify(benign));
  assert.equal(benign.body.decision, "allow");
  assert.equal(benign.body.guardrail_version, v2);
  const blocked = await runtime(phase, marker);
  assert.equal(blocked.body.decision, "block", JSON.stringify(blocked.body));
  const address = await runtime(phase, "Connect to 10.20.30.40 for the report");
  assert.notEqual(address.body.decision, "allow", JSON.stringify(address.body));
  assert.equal(blocked.body.usage?.model_invocations ?? 0, 0);
}
const later = await runtime("input", `${marker}_V2`);
assert.equal(later.body.decision, "allow", "The newer Library Policy did not leak into the released version.");
report("prod-serves-released-content", { guardrailVersion: v2 });

// Without a Policy Library, the Policy view is aggregated from released versions by Policy ID.
const released = (await prod.call("/api/v1/released-policies")).items;
const custom = released.find(item => item.policyId === policy.id);
assert(custom, "The custom Policy of the imported Guardrail is listed by its Policy ID.");
assert.equal(custom.source, "custom");
assert.deepEqual(custom.versions.map(item => item.version), ["1"], "Production lists the version it received, not the Library's newer v2.");
assert(custom.serving, "The routed version marks the Policy as serving.");
assert.equal(custom.versions[0].definition.implementation, "nemo_native", "Each version carries its frozen definition for the Library views.");
assert.deepEqual(custom.versions[0].definition.rules.map(rule => rule.id).sort(), phases.map(phase => `flow/${phase}/promotion_${phase}`).sort());
assert(custom.versions[0].usage.some(item => item.guardrailId === guardrail.id && item.guardrailVersion === v2 && item.serving && item.sourceId === "bank-uat"));
const networkPolicy = released.find(item => item.policyId === "local-network-addresses");
assert.deepEqual(new Set(networkPolicy.versions[0].usage.filter(item => item.guardrailId === guardrail.id).map(item => item.guardrailVersion)), new Set([v1, v2]));
report("prod-released-policies", { policies: released.length, custom: custom.policyId, versions: custom.versions.map(item => item.version) });

// ---------------------------------------------------------------- negative cases
const versionsBefore = await count(prodDb, "SELECT count(*) AS n FROM guardrail_version");
const tampered = readZip(both, LIMITS);
const artifactPath = [...tampered.keys()].find(path => path.endsWith(`${v2}/artifact.json`));
tampered.set(artifactPath, Buffer.from(tampered.get(artifactPath).toString().replace("full_buffered", "interruptible")));
assert.equal((await prod.upload(writeZip(tampered), "tampered.guardrail.zip", 422)).error.code, "guardrail_package_digest_mismatch");
const stranger = generateKeyPairSync("ed25519").privateKey;
const forged = reissue(exported, { sign: manifest => [{ keyId: "uat-2026", algorithm: "ed25519", signature: sign(null, manifest, stranger).toString("base64") }] });
assert.equal((await prod.upload(forged, "forged.guardrail.zip", 422)).error.code, "guardrail_package_untrusted");
const conflicting = reissue(exported, { sign: signer("uat-package.pem", "uat-2026"), mutate: content => content.guardrailVersion === v2 ? { ...content, configYaml: `${content.configYaml}# changed\n` } : content });
const conflictPreview = await prod.upload(conflicting, "conflict.guardrail.zip");
assert.deepEqual(conflictPreview.versions.map(item => item.state), ["existing", "conflict"]);
assert.equal((await prod.call(`/api/v1/guardrail-packages/${conflictPreview.packageId}/imports`, { body: {}, expected: 409 })).error.code, "guardrail_version_conflict");
const takeover = reissue(exported, { source: { id: "bank-uat-b", name: "Second UAT" }, sign: signer("other-package.pem", "uat-b") });
const takeoverPreview = await prod.upload(takeover, "takeover.guardrail.zip");
assert(takeoverPreview.blockers.some(item => item.code === "guardrail_ownership_conflict"));
assert.equal((await prod.call(`/api/v1/guardrail-packages/${takeoverPreview.packageId}/imports`, { body: {}, expected: 409 })).error.code, "guardrail_ownership_conflict");
const uatDefault = await uat.call("/api/v1/guardrails/guardrail-default/package", { binary: true });
const unauthorized = await prod.upload(uatDefault, "default.guardrail.zip");
assert(unauthorized.blockers.some(item => item.code === "guardrail_reserved_id"), JSON.stringify(unauthorized.blockers));
assert.equal((await prod.call(`/api/v1/guardrail-packages/${unauthorized.packageId}/imports`, { body: {}, expected: 409 })).error.code, "guardrail_reserved_id");
assert.equal(await count(prodDb, "SELECT count(*) AS n FROM guardrail_version"), versionsBefore, "Rejected packages wrote nothing.");
report("prod-rejections", { tampered: 422, untrusted: 422, conflict: 409, takeover: 409, reservedDefault: 409 });

// ---------------------------------------------------------------- a dependency this environment lacks
const future = reissue(parsePackage(latestOnly), { guardrail: { id: `${guardrail.id}-future`, name: `Future runtime ${runId}` }, sign: signer("uat-package.pem", "uat-2026"),
  mutate: content => ({ ...content, dependencyManifest: [...content.dependencyManifest, ["action", "GuardFutureAction", "9.0.0"]] }) });
const futurePreview = await prod.upload(future, "future.guardrail.zip");
const futureCheck = futurePreview.versions[0].environment;
assert.equal(futureCheck.status, "missing", JSON.stringify(futureCheck));
assert.match(futureCheck.pools[0].reason, /GuardFutureAction@9\.0\.0/, "The real Runner names the missing dependency.");
await prod.call(`/api/v1/guardrail-packages/${futurePreview.packageId}/imports`, { body: {}, expected: 201 });
const futureRouter = await prod.call("/api/v1/routers", { expected: 201, body: { name: `Future traffic ${runId}`, draft: { routes: [{
  id: "fallback", name: "Fallback", kind: "fallback", enabled: true, selector: { expression: { combinator: "and", conditions: [] } },
  targets: [{ id: "target", guardrailId: `${guardrail.id}-future`, guardrailVersion: v2, weightBps: 10_000 }] }] } } });
const futureReview = await prod.call(`/api/v1/routers/${futureRouter.id}/publication-preview`, { body: { expectedDraftRevision: futureRouter.draftRevision } });
const refused = await prod.call(`/api/v1/routers/${futureRouter.id}/change-requests`, { expected: 409, body: {
  expectedDraftRevision: futureRouter.draftRevision, reviewedSnapshot: futureReview.snapshot, reviewedEndpointIds: futureReview.endpointIds, reason: "CR-1003", ticket: "CR-1003" } });
assert.equal(refused.error.code, "guardrail_version_environment_unverified");
assert.equal((await runtime("input", marker)).body.decision, "block", "Existing traffic is unaffected.");
report("prod-missing-dependency", { status: futureCheck.status, reason: futureCheck.pools[0].reason, routerChange: refused.error.code });

// ---------------------------------------------------------------- runtime baseline
const systemSource = { id: "bank-uat-system", name: "UAT system baseline" };
const baselinePackage = reissue(parsePackage(uatDefault), { source: systemSource, sign: signer("system-package.pem", "system") });
const baselinePreview = await prod.upload(baselinePackage, "baseline.guardrail.zip");
assert.deepEqual(baselinePreview.blockers, []);
const previousBaseline = await prod.call("/api/v1/system/baseline");
const baselineImport = await prod.call(`/api/v1/guardrail-packages/${baselinePreview.packageId}/imports`, { body: {}, expected: 201 });
assert.deepEqual(await prod.call("/api/v1/system/baseline"), previousBaseline, "Importing never switches the baseline.");
const baselineVersion = baselinePreview.recommendedVersion;
const baseline = await prod.call("/api/v1/system/baseline", { method: "PUT", body: { version: baselineVersion, reason: "CR-1002 adopt UAT baseline" } });
assert.deepEqual(baseline, { guardrailId: "guardrail-default", version: baselineVersion, explicit: true });
const protectedStatus = await until("basic protection", () => systemStatus(prod),
  value => value.components.basicProtection.status === "ready");
report("prod-baseline", { version: baseline.version, freshProd, importedNow: baselineImport.imported.length, basicProtection: protectedStatus.components.basicProtection.status, status: protectedStatus.status });

await uatDb.end();
await prodDb.end();
report("passed", { guardrailId: guardrail.id, versions: [v1, v2], scope: "two isolated deployments: export, verify, import, Runner load check, approved routing, runtime evaluation, rejections and baseline" });
