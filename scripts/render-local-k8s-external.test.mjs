import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseEnvironment, renderExternalManifests } from './render-local-k8s-external.mjs';

const ids = ['tenantA', 'tenantB', 'tenantC'];
const modelKey = 'model-key-for-local-renderer-test-1234567890';
const config = `model_list:
  - model_name: "guarded-model"
    litellm_params:
      model: "openai/mock-model"
      api_base: "http://127.0.0.1:38120/v1"
      api_key: os.environ/LITELLM_UPSTREAM_API_KEY
credential_list:
  - credential_name: tasklattice-guard
    credential_values:
      api_key: os.environ/TASKLATTICE_GUARD_API_KEY
guardrails:
  - guardrail_name: tasklattice-guard
    litellm_params:
      guardrail: tasklattice_guard
      mode: [pre_call, post_call]
      api_base: os.environ/TASKLATTICE_GUARD_API_BASE
      default_on: true
      unreachable_fallback: fail_closed
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
`;
function fixture() {
  const gatewayInputs = Object.fromEntries(ids.map(id => [id, { config, model: 'guarded-model', environment: {
    LITELLM_MASTER_KEY: `gateway-${id}-private-key-12345`, LITELLM_UPSTREAM_API_KEY: modelKey,
    TASKLATTICE_GUARD_API_KEY: `endpoint-${id}-private-key-12345`,
    TASKLATTICE_GUARD_API_BASE: `http://127.0.0.1:${id === 'tenantC' ? 38083 : 38082}/runtime/v1/endpoints/endpoint-${id}`,
    STORE_MODEL_IN_DB: 'False', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False', LITELLM_LOG: 'ERROR',
  } }]));
  const labConfig = { runnerBaseUrl: 'http://127.0.0.1:38082', tenants: ids.map(id => ({ id,
    gatewayBaseUrl: `http://127.0.0.1:${38121 + ids.indexOf(id)}/v1`,
    gatewayApiKey: gatewayInputs[id].environment.LITELLM_MASTER_KEY, model: 'guarded-model',
    runnerBaseUrl: `http://127.0.0.1:${id === 'tenantC' ? 38083 : 38082}`,
    groupId: id === 'tenantC' ? 'group-demo' : 'default', groupName: id === 'tenantC' ? 'C' : 'A/B',
    poolId: id === 'tenantC' ? 'group-demo' : 'default',
  })) };
  const labManifest = { apiVersion: 'v1', kind: 'List', items: [
    { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'mt-demo-tenant-lab' }, stringData: { 'config.json': JSON.stringify(labConfig) } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'mt-demo-tenant-lab' }, spec: { template: { metadata: {}, spec: { containers: [] } } } },
  ] };
  return { modelApiKey: modelKey, gatewayInputs, labManifest, runnerBindings: {
    tenantA: 'http://runner-shared.example.svc:8091', tenantB: 'http://runner-shared.example.svc:8091',
    tenantC: 'http://runner-dedicated.example.svc:8091',
  } };
}

test('rendering preserves tenant credentials and upstream hooks while using Kubernetes services exclusively', () => {
  const input = fixture(), original = structuredClone(input), result = renderExternalManifests(input);
  assert.deepEqual(input, original, 'Rendering must not mutate private source fixtures.');
  assert.equal(result.applicationManifest.items.length, 15);
  const configMaps = result.applicationManifest.items.filter(item => item.kind === 'ConfigMap');
  assert.equal(configMaps.length, 3);
  for (const item of configMaps) {
    assert.equal(item.data['config.yaml'], config.replace('http://127.0.0.1:38120/v1', 'http://mt-demo-fake-llm:8097/v1'));
    assert(!item.data['config.yaml'].includes(modelKey));
  }
  const deployments = result.applicationManifest.items.filter(item => item.kind === 'Deployment');
  assert.equal(deployments.length, 4);
  const expectedModelLabels = { 'app.kubernetes.io/name': 'tasklattice-fake-llm', 'app.kubernetes.io/instance': 'mt-demo', 'app.kubernetes.io/component': 'external-model' };
  const modelDeployment = deployments.find(item => item.metadata.name === 'mt-demo-fake-llm');
  const modelService = result.applicationManifest.items.find(item => item.kind === 'Service' && item.metadata.name === 'mt-demo-fake-llm');
  assert.deepEqual(modelDeployment.spec.selector.matchLabels, expectedModelLabels);
  assert.deepEqual(modelDeployment.spec.template.metadata.labels, expectedModelLabels);
  assert.deepEqual(modelService.spec.selector, expectedModelLabels);
  for (const item of deployments) {
    assert.equal(item.spec.template.spec.automountServiceAccountToken, false);
    assert.equal(item.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert(!JSON.stringify(item).includes(modelKey));
  }
  for (const id of ids) {
    const name = `mt-demo-gateway-${id.at(-1).toLowerCase()}`;
    const secret = result.applicationManifest.items.find(item => item.kind === 'Secret' && item.metadata.name === name);
    assert.equal(secret.stringData.LITELLM_MASTER_KEY, input.gatewayInputs[id].environment.LITELLM_MASTER_KEY);
    assert.equal(secret.stringData.TASKLATTICE_GUARD_API_KEY, input.gatewayInputs[id].environment.TASKLATTICE_GUARD_API_KEY);
    assert.equal(secret.stringData.TASKLATTICE_GUARD_API_BASE,
      `${input.runnerBindings[id]}/runtime/v1/endpoints/endpoint-${id}`);
    assert(!Object.hasOwn(secret.stringData, 'DATABASE_URL'));
  }
  const lab = JSON.parse(result.labManifest.items[0].stringData['config.json']);
  assert.equal(lab.modelStatusUrl, 'http://mt-demo-fake-llm:8097/state');
  assert.equal(lab.modelStatusToken, modelKey);
  assert.deepEqual([lab.baselineMinRps, lab.baselineMaxRps, lab.baselineInitialRps, lab.peakRps], [0.75, 1.25, 1, 60]);
  assert.deepEqual(lab.tenants.map(item => item.gatewayBaseUrl), ['a', 'b', 'c'].map(letter => `http://mt-demo-gateway-${letter}:4000/v1`));
  assert.deepEqual(lab.tenants.map(item => item.groupId), ['default', 'default', 'group-demo']);
  assert(lab.tenants.every(item => !Object.hasOwn(item, 'credential') && !Object.hasOwn(item, 'endpointId')));
});

test('renderer fails closed on ambiguous tenant bindings, disabled protection and unsafe source inputs', () => {
  const mutations = [
    input => { input.gatewayInputs.tenantB.environment.LITELLM_MASTER_KEY = input.gatewayInputs.tenantA.environment.LITELLM_MASTER_KEY; },
    input => { input.gatewayInputs.tenantB.environment.TASKLATTICE_GUARD_API_KEY = input.gatewayInputs.tenantA.environment.TASKLATTICE_GUARD_API_KEY; },
    input => { input.gatewayInputs.tenantA.environment.LITELLM_UPSTREAM_API_KEY = 'wrong-model-key'; },
    input => { input.gatewayInputs.tenantA.environment.DATABASE_URL = 'unexpected'; },
    input => { input.gatewayInputs.tenantA.environment.TASKLATTICE_GUARD_API_BASE += '?credential=private'; },
    input => { input.gatewayInputs.tenantA.config = config.replace('default_on: true', 'default_on: false'); },
    input => { input.gatewayInputs.tenantA.config = config + '\nmock_response: bypass\n'; },
    input => { input.gatewayInputs.tenantA.config = config.replace('model_name: "guarded-model"', 'model_name: "different-model"'); },
    input => { input.gatewayInputs.tenantA.config = config.replace('http://127.0.0.1:38120/v1', 'https://external.example/v1'); },
    input => { delete input.runnerBindings; },
    input => { delete input.runnerBindings.tenantC; },
    input => { input.runnerBindings.tenantA = 'http://runner.example/path'; },
    input => { input.runnerBindings.tenantA = 'http://user:password@runner.example'; },
    input => { input.runnerBindings.tenantA = 'http://runner.example?key=value'; },
    input => { input.gatewayMemoryLimitMi = 64; },
    input => { input.gatewayMemoryRequestMi = 512; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => renderExternalManifests(input)); }
});

test('credential rotation changes only its tenant gateway rollout checksum and never puts the key in a Pod spec', () => {
  const input = fixture(), first = renderExternalManifests(input);
  const replacement = 'rotated-gateway-tenantA-key-1234567890';
  input.gatewayInputs.tenantA.environment.LITELLM_MASTER_KEY = replacement;
  const lab = JSON.parse(input.labManifest.items[0].stringData['config.json']);
  lab.tenants[0].gatewayApiKey = replacement;
  input.labManifest.items[0].stringData['config.json'] = JSON.stringify(lab);
  const second = renderExternalManifests(input);
  const deployment = (result, name) => result.applicationManifest.items.find(item => item.kind === 'Deployment' && item.metadata.name === name);
  const checksum = item => item.spec.template.metadata.annotations['checksum/config'];
  assert.notEqual(checksum(deployment(first, 'mt-demo-gateway-a')), checksum(deployment(second, 'mt-demo-gateway-a')));
  for (const name of ['mt-demo-gateway-b', 'mt-demo-gateway-c', 'mt-demo-fake-llm']) assert.equal(checksum(deployment(first, name)), checksum(deployment(second, name)));
  assert(!JSON.stringify(deployment(second, 'mt-demo-gateway-a')).includes(replacement));
});

test('environment parser rejects duplicates and never evaluates shell syntax', () => {
  assert.deepEqual(parseEnvironment('# private\nTEST_KEY=literal-$(not-executed)\n'), { TEST_KEY: 'literal-$(not-executed)' });
  assert.throws(() => parseEnvironment('TEST_KEY=one\nTEST_KEY=two'));
  assert.throws(() => parseEnvironment('export TEST_KEY=one'));
});

test('CLI writes only private manifests and a credential-free summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'k8s-external-render-'));
  const runtime = join(directory, 'runtime'), project = join(directory, 'model'), input = fixture(), messages = [];
  const previousLog = console.log;
  try {
    await mkdir(join(runtime, 'external-llm'), { recursive: true }); await mkdir(project);
    await writeFile(join(project, '.env'), `FAKE_LLM_API_KEY=${modelKey}\n`);
    await writeFile(join(runtime, 'lab-manifest.json'), JSON.stringify(input.labManifest));
    const gatewayMap = {};
    for (const id of ids) {
      await writeFile(join(runtime, 'external-llm', `${id}.yaml`), input.gatewayInputs[id].config);
      await writeFile(join(runtime, 'external-llm', `${id}.env`), Object.entries(input.gatewayInputs[id].environment).map(([key, value]) => `${key}=${value}`).join('\n'));
      gatewayMap[id] = { gatewayApiKey: input.gatewayInputs[id].environment.LITELLM_MASTER_KEY, model: 'guarded-model', runnerBaseUrl: input.runnerBindings[id] };
    }
    await writeFile(join(runtime, 'external-llm/gateways.json'), JSON.stringify(gatewayMap));
    console.log = value => messages.push(value);
    await main([], { GUARD_K8S_RUNTIME_DIR: runtime, GUARD_K8S_FAKE_PROJECT: project });
    console.log = previousLog;
    for (const name of ['application-manifest.json', 'lab-manifest.json']) {
      const path = join(runtime, 'k8s-external', name);
      assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(JSON.parse(await readFile(path, 'utf8')).kind, 'List');
    }
    assert(messages.length === 1 && !messages[0].includes(modelKey));
    assert.equal(JSON.parse(messages[0]).deployed, false);
  } finally { console.log = previousLog; await rm(directory, { recursive: true, force: true }); }
});
