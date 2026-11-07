#!/usr/bin/env node
/** Render private Kubernetes manifests for the existing local external-model lab.
 * Reads the existing per-tenant upstream configs and credentials; never applies
 * resources, builds images, prints credentials or implements a model/Guard hook.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { validateConfig } from './tenant-load-lab.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ids = ['tenantA', 'tenantB', 'tenantC'];
const environmentKeys = new Set(['LITELLM_MASTER_KEY', 'LITELLM_UPSTREAM_API_KEY',
  'TASKLATTICE_GUARD_API_KEY', 'TASKLATTICE_GUARD_API_BASE', 'LITELLM_LOCAL_MODEL_COST_MAP',
  'STORE_MODEL_IN_DB', 'LITELLM_TELEMETRY', 'LITELLM_LOG']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const token = (value, label, minimum = 1) => {
  assert(typeof value === 'string' && value.length >= minimum && /^[\x21-\x7e]{1,4096}$/.test(value), `${label} must be a bounded ASCII token.`);
  return value;
};
const boundedInteger = (value, fallback, min, max, label) => {
  const number = value === undefined ? fallback : Number(value);
  assert(Number.isSafeInteger(number) && number >= min && number <= max, `${label} must be an integer from ${min} to ${max}.`);
  return number;
};
const dns = (value, label) => {
  assert(typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value), `${label} must be a Kubernetes DNS label.`);
  return value;
};
const image = (value, label) => {
  assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9./:@_-]{0,511}$/.test(value), `${label} must be a bounded image reference.`);
  return value;
};

export function parseEnvironment(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    assert(match && !Object.hasOwn(result, match[1]), 'Environment input has a malformed or duplicate setting.');
    assert(!/[\r\n\0]/.test(match[2]), 'Environment input contains a control character.');
    result[match[1]] = match[2];
  }
  return result;
}

function upstreamConfiguration(text, modelBaseUrl, credentials) {
  assert(typeof text === 'string' && text.length > 0 && text.length <= 65536, 'Upstream configuration is missing or too large.');
  for (const pattern of [/guardrail:\s*tasklattice_guard\b/, /mode:\s*\[pre_call,\s*post_call\]/,
    /default_on:\s*true\b/, /unreachable_fallback:\s*fail_closed\b/,
    /api_key:\s*os\.environ\/LITELLM_UPSTREAM_API_KEY\b/,
    /api_key:\s*os\.environ\/TASKLATTICE_GUARD_API_KEY\b/,
    /api_base:\s*os\.environ\/TASKLATTICE_GUARD_API_BASE\b/,
    /master_key:\s*os\.environ\/LITELLM_MASTER_KEY\b/]) {
    assert(pattern.test(text), 'Expected upstream default-on Guard binding is missing.');
  }
  assert(!/\bmock_response\s*:/.test(text), 'Upstream configuration must call the external model.');
  assert(!credentials.some(value => text.includes(value)), 'Upstream ConfigMap must contain environment references, not credentials.');
  let count = 0;
  const output = text.replace(/^(\s+api_base:\s*)["']?(https?:\/\/[^\s"']+)["']?\s*$/gm, (line, prefix, raw) => {
    const url = new URL(raw);
    assert(['127.0.0.1', 'localhost', 'host.docker.internal', new URL(modelBaseUrl).hostname].includes(url.hostname)
      && url.pathname === '/v1' && !url.username && !url.password && !url.search && !url.hash,
    'Upstream model URL is not the expected local external service.');
    count++;
    return `${prefix}"${modelBaseUrl}"`;
  });
  assert.equal(count, 1, 'Expected exactly one external application model URL.');
  return output;
}

export function renderExternalManifests({ gatewayInputs, runnerBindings, modelApiKey, labManifest,
  namespace = 'mt-demo', prefix = 'mt-demo', gatewayImage = 'tasklattice-litellm-local:k8s-1.87.0-guard.3',
  modelImage = 'tasklattice-fake-llm:local-20261105', gatewayMemoryLimitMi = 384,
  gatewayMemoryRequestMi = 128, gatewayCpuRequestMilli = 10, gatewayReplicas = 1 } = {}) {
  dns(namespace, 'namespace'); dns(prefix, 'prefix');
  assert(prefix.length <= 40, 'prefix must leave room for local Service name suffixes.');
  image(gatewayImage, 'gateway image'); image(modelImage, 'model image'); token(modelApiKey, 'Model API key', 32);
  const memoryLimit = boundedInteger(gatewayMemoryLimitMi, 384, 128, 4096, 'gateway memory limit');
  const memoryRequest = boundedInteger(gatewayMemoryRequestMi, 128, 32, memoryLimit, 'gateway memory request');
  const cpuRequest = boundedInteger(gatewayCpuRequestMilli, 10, 1, 1000, 'gateway CPU request');
  const replicas = boundedInteger(gatewayReplicas, 1, 0, 1, 'gateway replicas');
  assert(gatewayInputs && Object.keys(gatewayInputs).sort().join(',') === [...ids].sort().join(','), 'Configure exactly tenantA, tenantB and tenantC.');
  const secretKeys = ids.map(id => token(gatewayInputs[id].environment?.LITELLM_MASTER_KEY, 'Gateway master key', 16));
  const endpointKeys = ids.map(id => token(gatewayInputs[id].environment?.TASKLATTICE_GUARD_API_KEY, 'Endpoint key', 16));
  assert.equal(new Set(secretKeys).size, 3, 'Each tenant must retain a distinct gateway master key.');
  assert.equal(new Set(endpointKeys).size, 3, 'Each tenant must retain a distinct Endpoint credential.');
  const metadata = (name, labels) => ({ name, namespace, ...(labels ? { labels } : {}) });
  const modelName = `${prefix}-fake-llm`, modelBase = `http://${modelName}:8097`;
  const labels = name => name === modelName
    ? { 'app.kubernetes.io/name': 'tasklattice-fake-llm', 'app.kubernetes.io/instance': prefix, 'app.kubernetes.io/component': 'external-model' }
    : { 'app.kubernetes.io/name': name, 'app.kubernetes.io/instance': prefix };
  assert(runnerBindings && Object.keys(runnerBindings).sort().join(',') === [...ids].sort().join(','),
    'Configure an explicit Runner service binding for each demo alias.');
  const runners = Object.fromEntries(ids.map(id => {
    assert(typeof runnerBindings[id] === 'string', 'Runner binding must be an HTTP service origin.');
    const url = new URL(runnerBindings[id]);
    assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === '/', 'Runner binding must be an HTTP service origin without credentials, path or query.');
    return [id, url.origin];
  }));
  const runnerBase = id => runners[id];
  const podSecurity = uid => ({ runAsNonRoot: true, runAsUser: uid, runAsGroup: uid, seccompProfile: { type: 'RuntimeDefault' } });
  const containerSecurity = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
  const items = [{ apiVersion: 'v1', kind: 'Secret', metadata: metadata(modelName), type: 'Opaque', stringData: { 'api-key': modelApiKey } }];
  const service = name => ({ apiVersion: 'v1', kind: 'Service', metadata: metadata(name, labels(name)), spec: {
    type: 'ClusterIP', selector: labels(name), ports: [{ name: 'http', port: name === modelName ? 8097 : 4000, targetPort: 'http' }],
  } });
  const deployment = (name, uid, container, volumes = [], count = 1, checksum) => ({ apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: metadata(name, labels(name)), spec: { replicas: count, strategy: { type: 'Recreate' }, selector: { matchLabels: labels(name) },
      template: { metadata: { labels: labels(name), annotations: { 'tasklattice.io/local-integration': 'k8s-external-v1', ...(checksum ? { 'checksum/config': checksum } : {}) } },
        spec: { automountServiceAccountToken: false, securityContext: podSecurity(uid), containers: [container], ...(volumes.length ? { volumes } : {}) } } } });
  items.push(deployment(modelName, 1000, { name: 'model', image: modelImage, imagePullPolicy: 'Never',
    ports: [{ name: 'http', containerPort: 8097 }], env: [
      ...Object.entries({ FAKE_LLM_HOST: '0.0.0.0', FAKE_LLM_PORT: '8097', FAKE_LLM_MODEL: 'mock-model', FAKE_LLM_DELAY_MS: '120', FAKE_LLM_MAX_CONCURRENCY: '1024' }).map(([name, value]) => ({ name, value })),
      { name: 'FAKE_LLM_API_KEY', valueFrom: { secretKeyRef: { name: modelName, key: 'api-key' } } },
    ], resources: { requests: { cpu: '10m', memory: '24Mi' }, limits: { memory: '96Mi' } }, securityContext: containerSecurity,
    readinessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 5, timeoutSeconds: 5 },
    livenessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 },
  }, [], 1, digest(modelApiKey)), service(modelName));

  const routes = {};
  for (const id of ids) {
    const input = gatewayInputs[id], env = { ...input.environment };
    assert(Object.keys(env).every(key => environmentKeys.has(key)), 'Gateway environment contains an unexpected setting.');
    assert.equal(env.LITELLM_UPSTREAM_API_KEY, modelApiKey, 'Gateway and external model credentials must agree.');
    const source = new URL(env.TASKLATTICE_GUARD_API_BASE);
    assert(['http:', 'https:'].includes(source.protocol) && !source.username && !source.password && !source.search && !source.hash,
      'Endpoint URL must be an HTTP URL without embedded credentials or query.');
    assert(/^\/runtime\/v1\/endpoints\/[A-Za-z0-9_-]{1,128}$/.test(source.pathname), 'Endpoint URL must identify one existing Runtime Endpoint.');
    const config = upstreamConfiguration(input.config, `${modelBase}/v1`, [modelApiKey, ...secretKeys, ...endpointKeys]);
    const model = input.model ?? 'guarded-model'; token(model, 'Gateway model');
    const aliases = [...config.matchAll(/^\s*-\s*model_name:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/gm)].map(match => match[1] ?? match[2] ?? match[3]);
    assert(aliases.length === 1 && aliases[0] === model, 'Upstream model alias differs from the tenant gateway binding.');
    env.TASKLATTICE_GUARD_API_BASE = runnerBase(id) + source.pathname;
    Object.assign(env, { STORE_MODEL_IN_DB: 'False', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False', LITELLM_LOG: 'ERROR', LITELLM_MODE: 'PRODUCTION', HOME: '/tmp', TMPDIR: '/tmp' });
    const name = `${prefix}-gateway-${id.at(-1).toLowerCase()}`;
    routes[id] = { gatewayBaseUrl: `http://${name}:4000/v1`, gatewayApiKey: env.LITELLM_MASTER_KEY, model };
    items.push({ apiVersion: 'v1', kind: 'Secret', metadata: metadata(name), type: 'Opaque', stringData: env },
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata(`${name}-config`), data: { 'config.yaml': config } },
      deployment(name, 65532, { name: 'gateway', image: gatewayImage, imagePullPolicy: 'Never', command: ['litellm'],
        args: ['--config', '/etc/litellm/config.yaml', '--host', '0.0.0.0', '--port', '4000', '--num_workers', '1'],
        ports: [{ name: 'http', containerPort: 4000 }], envFrom: [{ secretRef: { name } }],
        volumeMounts: [{ name: 'config', mountPath: '/etc/litellm/config.yaml', subPath: 'config.yaml', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }],
        resources: { requests: { cpu: `${cpuRequest}m`, memory: `${memoryRequest}Mi` }, limits: { memory: `${memoryLimit}Mi` } },
        securityContext: containerSecurity, startupProbe: { httpGet: { path: '/health/liveliness', port: 'http' }, periodSeconds: 5, timeoutSeconds: 5, failureThreshold: 90 },
        readinessProbe: { httpGet: { path: '/health/readiness', port: 'http' }, periodSeconds: 5, timeoutSeconds: 5 },
        livenessProbe: { httpGet: { path: '/health/liveliness', port: 'http' }, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 },
      }, [{ name: 'config', configMap: { name: `${name}-config` } }, { name: 'tmp', emptyDir: {} }], replicas, digest({ env, config })), service(name));
  }

  const lab = structuredClone(labManifest);
  assert(lab?.kind === 'List' && Array.isArray(lab.items), 'Expected the existing private lab resource List.');
  const labSecret = lab.items.find(item => item.kind === 'Secret' && item.metadata?.name === `${prefix}-tenant-lab`);
  const labDeployment = lab.items.find(item => item.kind === 'Deployment' && item.metadata?.name === `${prefix}-tenant-lab`);
  assert(labSecret?.stringData?.['config.json'] && labDeployment, 'Existing lab Secret and Deployment are required.');
  for (const container of labDeployment.spec.template.spec.containers) {
    for (const key of ['readinessProbe', 'livenessProbe']) if (container[key]) container[key].timeoutSeconds = 5;
  }
  const config = JSON.parse(labSecret.stringData['config.json']);
  assert(Array.isArray(config.tenants) && config.tenants.length === 3, 'Existing lab must contain three tenants.');
  for (const id of ids) {
    const matches = config.tenants.filter(item => item.id === id); assert.equal(matches.length, 1, 'Existing lab tenant configuration is ambiguous.');
    const tenant = matches[0];
    assert.equal(tenant.gatewayApiKey, routes[id].gatewayApiKey, 'Existing lab gateway credential differs from its tenant gateway.');
    assert.equal(tenant.model, routes[id].model, 'Existing lab gateway model differs from its tenant gateway.');
    Object.assign(tenant, routes[id], { runnerBaseUrl: runnerBase(id) });
    delete tenant.endpointId; delete tenant.credential;
  }
  Object.assign(config, { runnerBaseUrl: runnerBase('tenantA'), modelStatusUrl: `${modelBase}/state`, modelStatusToken: modelApiKey,
    baselineMinRps: 0.75, baselineMaxRps: 1.25, baselineInitialRps: 1, peakRps: 60 });
  validateConfig(config);
  labSecret.stringData['config.json'] = JSON.stringify(config, null, 2) + '\n';
  for (const item of lab.items) item.metadata.namespace = namespace;
  labDeployment.spec.template.metadata ??= {};
  labDeployment.spec.template.metadata.annotations ??= {};
  labDeployment.spec.template.metadata.annotations['tasklattice.io/local-integration'] = 'k8s-external-v1';
  labDeployment.spec.template.metadata.annotations['checksum/config'] = digest(config);
  return { applicationManifest: { apiVersion: 'v1', kind: 'List', items }, labManifest: lab };
}

async function privateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path); await chmod(path, 0o600);
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help')) {
    console.log(`Usage: node scripts/render-local-k8s-external.mjs\nRenders private application-manifest.json and lab-manifest.json; never deploys.\nGUARD_K8S_RUNTIME_DIR defaults to .local-secrets/external-demo.\nEach external-llm/gateways.json entry requires an operator-supplied runnerBaseUrl.\nGUARD_K8S_LAB_MANIFEST selects an operator-supplied Secret/Deployment List; defaults to lab-manifest.json in the runtime directory.\nGUARD_K8S_FAKE_PROJECT defaults to sibling ../tasklattice-fake-llm.\nOptional: GUARD_K8S_NAMESPACE, GUARD_K8S_PREFIX, GUARD_K8S_GATEWAY_IMAGE,\nGUARD_K8S_MODEL_IMAGE, GUARD_K8S_GATEWAY_MEMORY_LIMIT_MI (384),\nGUARD_K8S_GATEWAY_MEMORY_REQUEST_MI (128), GUARD_K8S_GATEWAY_CPU_REQUEST_MILLI (10), GUARD_K8S_GATEWAY_REPLICAS (1; 0 or1).`);
    return;
  }
  assert.equal(argv.length, 0, 'This renderer accepts environment options only; use --help.');
  const runtime = resolve(repository, env.GUARD_K8S_RUNTIME_DIR ?? '.local-secrets/external-demo');
  const project = resolve(repository, env.GUARD_K8S_FAKE_PROJECT ?? '../tasklattice-fake-llm');
  const modelEnv = parseEnvironment(await readFile(resolve(project, '.env'), 'utf8'));
  const gatewayMap = JSON.parse(await readFile(resolve(runtime, 'external-llm/gateways.json'), 'utf8'));
  const gatewayInputs = Object.fromEntries(await Promise.all(ids.map(async id => [id, {
    config: await readFile(resolve(runtime, 'external-llm', `${id}.yaml`), 'utf8'),
    environment: parseEnvironment(await readFile(resolve(runtime, 'external-llm', `${id}.env`), 'utf8')),
    model: gatewayMap[id]?.model,
  }])));
  for (const id of ids) assert.equal(gatewayMap[id]?.gatewayApiKey, gatewayInputs[id].environment.LITELLM_MASTER_KEY, 'Existing gateway map and environment credentials disagree.');
  const result = renderExternalManifests({ gatewayInputs, modelApiKey: modelEnv.FAKE_LLM_API_KEY,
    runnerBindings: Object.fromEntries(ids.map(id => [id, gatewayMap[id]?.runnerBaseUrl])),
    labManifest: JSON.parse(await readFile(env.GUARD_K8S_LAB_MANIFEST ? resolve(repository, env.GUARD_K8S_LAB_MANIFEST) : resolve(runtime, 'lab-manifest.json'), 'utf8')),
    namespace: env.GUARD_K8S_NAMESPACE, prefix: env.GUARD_K8S_PREFIX,
    gatewayImage: env.GUARD_K8S_GATEWAY_IMAGE, modelImage: env.GUARD_K8S_MODEL_IMAGE,
    gatewayMemoryLimitMi: env.GUARD_K8S_GATEWAY_MEMORY_LIMIT_MI,
    gatewayMemoryRequestMi: env.GUARD_K8S_GATEWAY_MEMORY_REQUEST_MI,
    gatewayCpuRequestMilli: env.GUARD_K8S_GATEWAY_CPU_REQUEST_MILLI,
    gatewayReplicas: env.GUARD_K8S_GATEWAY_REPLICAS });
  const output = resolve(runtime, 'k8s-external'); await mkdir(output, { recursive: true, mode: 0o700 });
  await privateJson(resolve(output, 'application-manifest.json'), result.applicationManifest);
  await privateJson(resolve(output, 'lab-manifest.json'), result.labManifest);
  console.log(JSON.stringify({ rendered: true, outputDirectory: output, applicationResources: result.applicationManifest.items.length,
    labResources: result.labManifest.items.length, deployed: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error('Private external-service rendering failed; verify the input bindings and use --help for supported settings.'); process.exitCode = 1; });
