import readline from 'readline';
import { Writable } from 'node:stream';
import axios, { AxiosRequestConfig } from 'axios';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
const cliDirectory = dirname(resolve(process.argv[1]));

function loadEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(path)) return result;
  try {
    const raw = readFileSync(path, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  } catch { /* ignore */ }
  return result;
}

function resolveBaseUrl(): { url: string; source: string } {
  const cliArg = process.argv.find((a) => a.startsWith('--url='));
  if (cliArg) {
    return { url: cliArg.slice('--url='.length), source: '--url flag' };
  }
  if (process.env.GUARD_URL) {
    return { url: process.env.GUARD_URL, source: 'GUARD_URL env' };
  }
  if (process.env.CONTROLLER_PUBLIC_URL) {
    return { url: process.env.CONTROLLER_PUBLIC_URL, source: 'CONTROLLER_PUBLIC_URL env' };
  }

  const searchDirs = [
    process.cwd(),
    resolve(cliDirectory, '../../..'),
    resolve(cliDirectory, '../..'),
    resolve(cliDirectory, '..'),
  ];
  for (const dir of searchDirs) {
    const envPath = resolve(dir, '.env');
    const env = loadEnvFile(envPath);
    if (env.CONTROLLER_PUBLIC_URL) {
      return { url: env.CONTROLLER_PUBLIC_URL, source: `${envPath} CONTROLLER_PUBLIC_URL` };
    }
    const host = env.CONTROLLER_HTTP_HOST || 'localhost';
    const port = env.CONTROLLER_HTTP_PORT || '8080';
    if (env.CONTROLLER_HTTP_PORT || env.CONTROLLER_HTTP_HOST) {
      const hostClean = host === '0.0.0.0' ? 'localhost' : host;
      return { url: `http://${hostClean}:${port}`, source: `${envPath} CONTROLLER_HTTP_HOST/PORT` };
    }
  }

  return { url: 'http://localhost:8080', source: 'default fallback' };
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const nxt = args[i + 1];
        if (nxt && !nxt.startsWith('--')) {
          flags[a.slice(2)] = nxt;
          i++;
        } else {
          flags[a.slice(2)] = 'true';
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function buildQs(flags: Record<string, string | undefined>, allowList: string[]): string {
  const params = new URLSearchParams();
  for (const k of allowList) {
    if (flags[k] !== undefined) params.set(k, flags[k]);
  }
  const str = params.toString();
  return str ? `?${str}` : '';
}

const TABLE_PREVIEW_ROWS = 20;
let lastShowArgs: string[] | null = null;

function printJson(data: any) {
  if (data === null || data === undefined) return;
  console.log(JSON.stringify(data, null, 2));
}

function scalar(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

type TableColumn = { label: string; value: (row: any) => any };

function renderTable(title: string, rows: any[], columns: TableColumn[], detail = false) {
  console.log(`\n${title}`);
  if (!rows.length) { console.log('(none)'); return; }
  const shown = detail ? rows : rows.slice(0, TABLE_PREVIEW_ROWS);
  const values = shown.map((row) => columns.map((column) => scalar(column.value(row)).replace(/\s+/g, ' ')));
  const widths = columns.map((column, index) => Math.max(column.label.length, ...values.map((row) => row[index].length)));
  console.log(columns.map((column, index) => column.label.padEnd(widths[index])).join(' | '));
  console.log(widths.map((width) => '-'.repeat(width)).join('-+-'));
  values.forEach((row) => console.log(row.map((value, index) => value.padEnd(widths[index])).join(' | ')));
  if (!detail && rows.length > shown.length) console.log(`Showing ${shown.length} of ${rows.length}. Press d or use --detail for all rows.`);
}

function listItems(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return data === null || data === undefined ? [] : [data];
}

function flattenFields(value: any, prefix = ''): Array<{ field: string; value: string }> {
  if (value === null || value === undefined || typeof value !== 'object') return [{ field: prefix || 'value', value: scalar(value) }];
  if (Array.isArray(value)) {
    if (!value.length) return [{ field: prefix, value: '(none)' }];
    return value.flatMap((item, index) => flattenFields(item, `${prefix}[${index}]`));
  }
  return Object.entries(value).flatMap(([key, item]) => flattenFields(item, prefix ? `${prefix}.${key}` : key));
}

function printRunnerPools(data: any, detail: boolean) {
  const pools = listItems(data);
  renderTable('Runner pools', pools, [
    { label: 'ID', value: (p) => p.id }, { label: 'NAME', value: (p) => p.name },
    { label: 'DEFAULT', value: (p) => p.isDefault }, { label: 'DESIRED', value: (p) => p.desiredReplicas },
    { label: 'READY/TOTAL', value: (p) => `${p.capacity?.readyRunners ?? 0}/${p.capacity?.totalRunners ?? p.instances?.length ?? 0}` },
    { label: 'SAFE RPS/RUNNER', value: (p) => p.safeRpsPerRunner },
    { label: 'CURRENT/CAPACITY RPS', value: (p) => `${p.capacity?.currentRps ?? 0}/${p.capacity?.safeRpsCapacity ?? 0}` },
    { label: 'UTILIZATION', value: (p) => `${Math.round((p.capacity?.utilization ?? 0) * 100)}%` },
    { label: 'HEADROOM RPS', value: (p) => p.capacity?.headroomRps ?? 0 },
  ], detail);
  const runners = pools.flatMap((pool) => (pool.instances ?? []).map((runner: any) => ({ ...runner, poolName: pool.name })));
  renderTable('Runner instances', runners, [
    { label: 'POOL', value: (r) => r.poolName ?? r.poolId }, { label: 'RUNNER ID', value: (r) => r.runnerId },
    { label: 'STATUS', value: (r) => r.status }, { label: 'RUNNER', value: (r) => r.runnerVersion },
    { label: 'NEMO', value: (r) => r.nemoVersion }, { label: 'COMPILER', value: (r) => r.compilerCapable },
    { label: 'GENERATION', value: (r) => `${r.appliedGeneration ?? 0}/${r.desiredGeneration ?? 0}` },
    { label: 'INFLIGHT/MAX', value: (r) => `${r.load?.inflight ?? 0}/${r.load?.maxConcurrency ?? r.maxConcurrency ?? 0}` },
    { label: 'QUEUE', value: (r) => r.load?.queueDepth ?? 0 }, { label: 'LAST HEARTBEAT', value: (r) => r.lastHeartbeatAt },
  ], detail);
}

function outputJson(data: any, path?: string) {
  if (!path) {
    printJson(data);
    return;
  }
  if (path === '-') {
    printJson(data);
    return;
  }
  writeFileSync(resolve(process.cwd(), path), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`Wrote full output to ${resolve(process.cwd(), path)}`);
}

function outputHuman(resource: string, data: any, detail = false) {
  if (resource === 'runner-pools' || resource === 'runners') { printRunnerPools(data, detail); return; }
  const rows = listItems(data);
  const columns: Record<string, TableColumn[]> = {
    providers: [
      { label: 'ID', value: (r) => r.id }, { label: 'NAME', value: (r) => r.name }, { label: 'KIND', value: (r) => r.kind },
      { label: 'STATUS', value: (r) => r.status }, { label: 'BASE URL', value: (r) => r.baseUrl },
      { label: 'CREDENTIAL', value: (r) => r.credentialHint }, { label: 'LATENCY MS', value: (r) => r.validationLatencyMs },
    ],
    models: [
      { label: 'ID', value: (r) => r.id }, { label: 'NAME', value: (r) => r.name }, { label: 'PROVIDER', value: (r) => r.providerName },
      { label: 'MODEL', value: (r) => r.model }, { label: 'PROFILE', value: (r) => r.profile }, { label: 'STATUS', value: (r) => r.status },
    ],
    policies: [
      { label: 'ID', value: (r) => r.id }, { label: 'NAME', value: (r) => r.name }, { label: 'STATUS', value: (r) => r.status },
      { label: 'VERSION', value: (r) => r.version }, { label: 'UPDATED', value: (r) => r.updatedAt },
    ],
    guardrails: [
      { label: 'ID', value: (r) => r.id }, { label: 'NAME', value: (r) => r.name }, { label: 'STATUS', value: (r) => r.status },
      { label: 'DRAFT', value: (r) => r.draftRevision },
      { label: 'GENERATION', value: (r) => r.desiredGeneration }, { label: 'TESTS', value: (r) => r.testCaseCount },
    ],
    endpoints: [
      { label: 'ID', value: (r) => r.id }, { label: 'NAME', value: (r) => r.name }, { label: 'ADAPTER', value: (r) => r.adapter },
      { label: 'STATUS', value: (r) => r.status }, { label: 'GENERATION', value: (r) => r.desiredGeneration },
      { label: 'DISTRIBUTION', value: (r) => r.distributionStatus },
    ],
    routers: [
      { label: 'ID', value: (r) => r.id }, { label: 'NAME', value: (r) => r.name }, { label: 'STATUS', value: (r) => r.status },
      { label: 'ENDPOINTS', value: (r) => r.endpointIds?.length ?? (r.endpointId ? 1 : 0) },
      { label: 'DRAFT', value: (r) => r.draftRevision }, { label: 'ACTIVE', value: (r) => r.activeRevision },
      { label: 'GENERATION', value: (r) => r.desiredGeneration },
    ],
    routes: [
      { label: 'ID', value: (r) => r.id }, { label: 'NAME', value: (r) => r.name }, { label: 'ENABLED', value: (r) => r.enabled },
      { label: 'ORDER', value: (r) => r.order }, { label: 'TARGETS', value: (r) => r.targets?.length ?? 0 },
      { label: 'FALLBACK', value: (r) => r.fallback ?? r.isFallback },
    ],
    'telemetry-events': [
      { label: 'TIME', value: (r) => r.occurredAt }, { label: 'REQUEST', value: (r) => r.requestId }, { label: 'RUNNER', value: (r) => r.runnerId },
      { label: 'ROUTER', value: (r) => r.routerId }, { label: 'GUARDRAIL', value: (r) => r.guardrailId },
      { label: 'DIRECTION', value: (r) => r.direction }, { label: 'DECISION', value: (r) => r.decision ?? r.outcome },
      { label: 'MS', value: (r) => r.durationMs },
    ],
    'audit-events': [
      { label: 'TIME', value: (r) => r.occurredAt }, { label: 'KIND', value: (r) => r.kind }, { label: 'ACTOR', value: (r) => r.actorId },
      { label: 'RESOURCE', value: (r) => `${r.resourceType ?? ''}/${r.resourceId ?? ''}` },
    ],
  };
  const selected = columns[resource];
  if (selected) { renderTable(resource, rows, selected, detail); return; }
  renderTable(resource, flattenFields(data), [
    { label: 'FIELD', value: (r) => r.field }, { label: 'VALUE', value: (r) => r.value },
  ], detail);
}

const { url: resolvedUrl, source: urlSource } = resolveBaseUrl();

interface Session {
  token: string | null;
  authCookie: string | null;
  privileged: boolean;
  baseUrl: string;
  urlSource: string;
}

const session: Session = {
  token: null,
  authCookie: null,
  privileged: false,
  baseUrl: resolvedUrl,
  urlSource,
};

// readline owns terminal input and echoing. Muting its output is essential:
// a second stdin listener alone does not prevent readline echoing credentials.
let hiddenInput = false;
const terminalOutput = new Writable({
  write(chunk, encoding, callback) {
    if (!hiddenInput) process.stdout.write(chunk, encoding);
    callback();
  },
});
const rl = readline.createInterface({
  input: process.stdin,
  output: terminalOutput,
  terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
});
const inputLines: string[] = [];
let inputClosed = false;
let waitingForLine: ((line: string | null) => void) | null = null;
rl.on('line', (line) => {
  if (waitingForLine) {
    const resolve = waitingForLine;
    waitingForLine = null;
    resolve(line);
  } else inputLines.push(line);
});
rl.on('close', () => {
  inputClosed = true;
  waitingForLine?.(null);
  waitingForLine = null;
});
rl.on('SIGINT', () => rl.close());

async function prompt(text: string): Promise<string | null> {
  if (process.stdin.isTTY) process.stdout.write(text);
  if (inputLines.length) return inputLines.shift()!;
  if (inputClosed) return null;
  return new Promise(resolve => { waitingForLine = resolve; });
}

async function promptHidden(text: string): Promise<string | null> {
  hiddenInput = true;
  try {
    return await prompt(text);
  } finally {
    hiddenInput = false;
    if (process.stdin.isTTY) process.stdout.write('\n');
  }
}

async function runApi(
  method: string,
  path: string,
  data?: any,
  extraConfig: Partial<AxiosRequestConfig> & { omitCredentials?: boolean } = {},
) {
  const { omitCredentials = false, ...axiosConfig } = extraConfig;
  const headers: Record<string, string> = { ...(axiosConfig.headers as any) };
  // A Better Auth session is the authority in privileged mode. Do not also
  // attach the read PAT, whose grants may be narrower than the admin session.
  if (!omitCredentials && session.token && !session.authCookie) {
    headers['Authorization'] = `Bearer ${session.token}`;
  }
  if (!omitCredentials && session.authCookie) {
    headers['Cookie'] = session.authCookie;
  }

  try {
    const response = await axios({
      method,
      url: `${session.baseUrl}${path}`,
      data,
      headers,
      withCredentials: Boolean(session.authCookie),
      timeout: 15_000,
      ...axiosConfig,
      validateStatus: () => true,
    });
    if (response.status >= 200 && response.status < 300) {
      const setCookies = (response.headers as any)['set-cookie'];
      if (Array.isArray(setCookies) && setCookies.length) {
        session.authCookie = setCookies.map((c) => c.split(';')[0]).join('; ');
      } else if (typeof setCookies === 'string') {
        session.authCookie = setCookies.split(';')[0];
      }
      return { ok: true, status: response.status, data: response.data as any, headers: response.headers as Record<string, unknown> };
    }
    return { ok: false, status: response.status, data: response.data as any };
  } catch (error: any) {
    return { ok: false, status: -1, error: error.message as string };
  }
}

function option(args: string[], name: string): string | undefined {
  return args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function apiError(response: { status: number; data?: any; error?: string }): string {
  let data = response.data;
  if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
    try { data = JSON.parse(Buffer.from(data as ArrayBuffer).toString('utf8')); } catch { data = undefined; }
  }
  const detail = data?.error?.detail ? `\n${JSON.stringify(data.error.detail, null, 2)}` : '';
  return `${data?.error?.code ?? `HTTP ${response.status}`}: ${data?.error?.message ?? response.error ?? 'request failed'}${detail}`;
}

/** Download a signed release package for published versions. */
async function handleExport(args: string[]) {
  const id = args.find(arg => !arg.startsWith('--'));
  if (!id) {
    console.log('Usage: export <guardrail-id> --versions=a,b [--out=<file>]');
    return;
  }
  // A package always names its versions; nothing is exported by default.
  const versions = option(args, 'versions');
  if (!versions) {
    console.error('Export failed: choose the versions with --versions=a,b.');
    process.exitCode = 1;
    return;
  }
  const response = await runApi('GET', `/api/v1/guardrails/${encodeURIComponent(id)}/package?versions=${encodeURIComponent(versions)}`,
    undefined, { responseType: 'arraybuffer', timeout: 60_000 });
  if (!response.ok) {
    console.error(`Export failed: ${apiError(response)}`);
    process.exitCode = 1;
    return;
  }
  const disposition = String(response.headers?.['content-disposition'] ?? '');
  const out = option(args, 'out') ?? /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${id}.guardrail.zip`;
  writeFileSync(out, Buffer.from(response.data as ArrayBuffer));
  console.log(`Wrote ${out}`);
}

/** Verify a package against this environment, preview it, and import with --confirm. */
async function handleImport(args: string[]) {
  const file = args.find(arg => !arg.startsWith('--'));
  if (!file || !existsSync(file)) {
    console.log('Usage: import <file> [--versions=a,b] [--confirm]');
    return;
  }
  const form = new FormData();
  form.append('package', new Blob([readFileSync(file)], { type: 'application/zip' }), basename(file));
  const uploaded = await runApi('POST', '/api/v1/guardrail-packages', form, { timeout: 120_000 });
  if (!uploaded.ok) {
    console.error(`Package rejected: ${apiError(uploaded)}`);
    process.exitCode = 1;
    return;
  }
  const preview = uploaded.data;
  console.log(`Source:    ${preview.source.name} (${preview.source.id}), key ${preview.keyId}`);
  console.log(`Guardrail: ${preview.guardrail.name} (${preview.guardrail.id})${preview.guardrail.exists ? '' : ' — new in this environment'}`);
  for (const item of preview.versions) {
    const metrics = item.evidence.metrics ?? {};
    const tested = typeof metrics.total === 'number' ? ` (${metrics.passed ?? 0}/${metrics.total} cases)` : '';
    console.log(`  ${item.version}  ${item.state.padEnd(8)} source test: ${item.evidence.status}${tested}  environment: ${item.environment?.status ?? 'not checked'}`);
    for (const pool of item.environment?.pools ?? []) if (!pool.admitted && !pool.unavailable) console.log(`      ${pool.poolId}/${pool.runnerId}: ${pool.reason}`);
  }
  for (const blocker of preview.blockers) console.log(`Blocked: ${blocker.message}`);
  const requested = option(args, 'versions')?.split(',').filter(Boolean);
  const fresh = preview.versions.filter((item: any) => item.state === 'new' && (!requested || requested.includes(item.version)));
  if (preview.blockers.length || !fresh.length) {
    console.log(preview.blockers.length ? 'Nothing was imported.' : 'Nothing new to import.');
    if (preview.blockers.length) process.exitCode = 1;
    return;
  }
  let confirmed = args.includes('--confirm');
  if (!confirmed && process.stdin.isTTY) {
    confirmed = (await prompt(`Import ${fresh.length} version(s)? [y/N] `))?.trim().toLowerCase() === 'y';
  } else if (!confirmed) {
    console.log('Preview only. Re-run with --confirm to import.');
    return;
  }
  if (!confirmed) {
    console.log('Nothing was imported.');
    return;
  }
  const imported = await runApi('POST', `/api/v1/guardrail-packages/${preview.packageId}/imports`, requested ? { versions: requested } : {});
  if (!imported.ok) {
    console.error(`Import failed: ${apiError(imported)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Imported ${imported.data.imported.length} version(s), ${imported.data.existing.length} already present.`);
}

async function handleShow(args: string[]) {
  if (args.length === 0) {
    console.log('Usage: show <resource> [<id>] [--flags...]');
    console.log('Resources:');
    console.log('  system  | identity | access-tokens');
    console.log('  providers | models | model-configuration');
    console.log('  policies [<id>] | policy-test <policy-id> [<run-id>]');
    console.log('  protection-presets | actions');
    console.log('  guardrails [<id>] | guardrail-logging <id> | test-cases <guardrail-id>');
    console.log('  test-runs [--guardrail <id>]');
    console.log('  endpoints [<id>] | routers [<id>]');
    console.log('  router-revisions <router-id> [<revision>]');
    console.log('  routes <router-id> [--revision <n>]');
    console.log('  route-distribution <router-id> [--route <id>] [--endpoint <id>] [--window <dur>] [--revision <n>]');
    console.log('  selector-fields [--endpoints <id,...>]');
    console.log('  runner-pools [<pool-id>] | runners [--pool <id>]');
    console.log('  telemetry-events [filters...] | telemetry-event <event-id>');
    console.log('  telemetry-metrics [--router <id>] [--guardrail <id>] [--window 1h|24h|7d|15d|30d]');
    console.log('  endpoint-activity | audit-events [--limit <n>]');
    console.log('  Add --detail for the full table, or --output <file> (--out <file>) for full JSON.');
    return;
  }
  const { positional, flags } = parseFlags(args);
  lastShowArgs = [...args];
  const resource = positional[0];
  const p1 = positional[1];
  const p2 = positional[2];

  let res: { ok: boolean; status: number; data?: any; error?: string } | null = null;

  switch (resource) {
    case 'system':
      res = await runApi('GET', '/api/v1/system/status');
      break;
    case 'identity':
      res = await runApi('GET', '/api/v1/account/identity');
      break;
    case 'access-tokens':
      res = await runApi('GET', '/api/v1/account/access-tokens');
      break;
    case 'providers':
      res = await runApi('GET', '/api/v1/model-providers');
      break;
    case 'models':
      res = await runApi('GET', '/api/v1/models');
      break;
    case 'model-configuration':
      res = await runApi('GET', '/api/v1/model-configuration');
      break;
    case 'policies':
      res = await runApi('GET', `/api/v1/policies${p1 ? '/' + encodeURIComponent(p1) : ''}`);
      break;
    case 'policy-test':
    case 'policy-validation':
      if (!p1) {
        console.log('Usage: show policy-test <policy-id> [<run-id>]');
        return;
      }
      if (p2) {
        res = await runApi('GET', `/api/v1/policies/${encodeURIComponent(p1)}/test-runs/${encodeURIComponent(p2)}`);
      } else {
        res = await runApi('GET', `/api/v1/policies/${encodeURIComponent(p1)}/test-runs/latest`);
      }
      break;
    case 'protection-presets':
      res = await runApi('GET', '/api/v1/policy-catalog/protection-presets');
      break;
    case 'actions':
      res = await runApi('GET', '/api/v1/policy-catalog/actions');
      break;
    case 'guardrails':
      res = await runApi('GET', `/api/v1/guardrails${p1 ? '/' + encodeURIComponent(p1) : ''}`);
      break;
    case 'guardrail-logging':
      if (!p1) { console.log('Usage: show guardrail-logging <guardrail-id>'); return; }
      res = await runApi('GET', `/api/v1/guardrails/${encodeURIComponent(p1)}/logging`);
      break;
    case 'test-cases':
      if (!p1) { console.log('Usage: show test-cases <guardrail-id>'); return; }
      res = await runApi('GET', `/api/v1/guardrails/${encodeURIComponent(p1)}/test-cases`);
      break;
    case 'test-runs':
    case 'validation-runs': {
      const qs = buildQs({ guardrailId: flags.guardrail }, ['guardrailId']);
      res = await runApi('GET', `/api/v1/test-runs${qs}`);
      break;
    }
    case 'endpoints':
      res = await runApi('GET', `/api/v1/endpoints${p1 ? '/' + encodeURIComponent(p1) : ''}`);
      break;
    case 'routers':
      res = await runApi('GET', `/api/v1/routers${p1 ? '/' + encodeURIComponent(p1) : ''}`);
      break;
    case 'router-revisions':
      if (!p1) { console.log('Usage: show router-revisions <router-id> [<revision>]'); return; }
      res = await runApi('GET', `/api/v1/routers/${encodeURIComponent(p1)}/revisions${p2 ? '/' + encodeURIComponent(p2) : ''}`);
      break;
    case 'routes': {
      if (!p1) { console.log('Usage: show routes <router-id> [--revision <n>]'); return; }
      const revision = flags.revision;
      if (revision) {
        res = await runApi('GET', `/api/v1/routers/${encodeURIComponent(p1)}/revisions/${encodeURIComponent(revision)}`);
      } else {
        res = await runApi('GET', `/api/v1/routers/${encodeURIComponent(p1)}`);
      }
      if (res?.ok && res?.data) {
        const routes = res.data.routes ?? res.data.draft?.routes ?? res.data.active?.routes ?? res.data.snapshot?.routes ?? null;
        if (routes) {
          if (flags.output ?? flags.out) outputJson(routes, flags.output ?? flags.out);
          else outputHuman('routes', routes, flags.detail === 'true');
          return;
        } else {
          console.log('No routes field found in Router payload; falling back to full resource:');
        }
      }
      break;
    }
    case 'route-distribution': {
      if (!p1) { console.log('Usage: show route-distribution <router-id> [--route <id>] [--endpoint <id>] [--window <dur>] [--revision <n>]'); return; }
      const routeId = flags.route;
      const ep = flags.endpoint;
      const window = flags.window ?? '24h';
      const duration = /^(\d+(?:\.\d+)?)(h|d)$/.exec(window);
      const hours = duration ? Number(duration[1]) * (duration[2] === 'd' ? 24 : 1) : NaN;
      if (!Number.isFinite(hours) || hours < 0.25 || hours > 168) {
        console.error('Error: --window must be between 0.25h and 7d.');
        if (!process.stdin.isTTY) process.exitCode = 1;
        return;
      }
      const revision = flags.revision;
      const qs = buildQs({ endpointId: ep, hours: String(hours), revision }, ['endpointId', 'hours', 'revision']);
      if (routeId) {
        res = await runApi('GET', `/api/v1/routers/${encodeURIComponent(p1)}/routes/${encodeURIComponent(routeId)}/traffic-distribution${qs}`);
      } else {
        res = await runApi('GET', `/api/v1/routers/${encodeURIComponent(p1)}/traffic-distribution${qs}`);
      }
      break;
    }
    case 'selector-fields': {
      const qs = buildQs({ endpointIds: flags.endpoints }, ['endpointIds']);
      res = await runApi('GET', `/api/v1/routing/selector-fields${qs}`);
      break;
    }
    case 'runner-pools':
    case 'runners': {
      // The API exposes a collection, not GET /runner-pools/:id or ?pool=.
      res = await runApi('GET', '/api/v1/runner-pools');
      const pool = resource === 'runner-pools' ? p1 : flags.pool;
      if (res.ok && pool) res.data = { items: listItems(res.data).filter(item => item.id === pool) };
      break;
    }
    case 'telemetry-events': {
      const qs = buildQs({ routerId: flags.router, routeId: flags.route, targetId: flags.target, endpointId: flags.endpoint, guardrailId: flags.guardrail, requestId: flags.request, since: flags.since, before: flags.before, cursor: flags.cursor, limit: flags.limit }, ['routerId', 'routeId', 'targetId', 'endpointId', 'guardrailId', 'requestId', 'since', 'before', 'cursor', 'limit']);
      res = await runApi('GET', `/api/v1/telemetry/events${qs}`);
      break;
    }
    case 'telemetry-event':
      if (!p1) { console.log('Usage: show telemetry-event <event-id>'); return; }
      res = await runApi('GET', `/api/v1/telemetry/events/${encodeURIComponent(p1)}`);
      break;
    case 'telemetry-metrics': {
      const qs = buildQs({ routerId: flags.router, guardrailId: flags.guardrail, window: flags.window }, ['routerId', 'guardrailId', 'window']);
      res = await runApi('GET', `/api/v1/telemetry/metrics${qs}`);
      break;
    }
    case 'endpoint-activity':
      res = await runApi('GET', '/api/v1/telemetry/endpoint-activity');
      break;
    case 'audit-events': {
      const qs = buildQs(flags, ['limit']);
      res = await runApi('GET', `/api/v1/audit-events${qs}`);
      break;
    }
    default:
      console.log(`Unknown resource: ${resource}. Try 'show' with no args for the list.`);
      return;
  }

  if (!res) return;
  if (res.ok) {
    if (flags.output ?? flags.out) outputJson(res.data, flags.output ?? flags.out);
    else outputHuman(resource, res.data, flags.detail === 'true');
  } else if (res.error) {
    if (!process.stdin.isTTY) process.exitCode = 1;
    console.error(`Network Error: ${res.error}`);
  } else {
    if (!process.stdin.isTTY) process.exitCode = 1;
    const body = typeof res.data === 'object' && res.data ? JSON.stringify(res.data) : String(res.data ?? '');
    console.error(`Error: ${res.status} ${body ? ' — ' + body : ''}`);
    if (res.status === 401 && !session.token && !session.authCookie) {
      console.error('Authenticate first with `read` (a PAT) or `enable` (an administrator session).');
    }
  }
}

async function handleCommand(line: string) {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (!cmd) return;

  if (cmd === 'exit' || cmd === 'quit') {
    console.log('Exiting...');
    rl.close();
    process.exit(process.exitCode ?? 0);
  }

  if (cmd === 'help') {
    console.log('Commands:');
    console.log('  connect [<url>]              View or change Controller URL');
    console.log('  read                         Authenticate with PAT (read-only)');
    console.log('  enable                       Sign in as administrator');
    console.log('  disable                      Drop back to read-only credentials');
    console.log('  show <resource> ...          Read a resource; run "show" for list');
    console.log('  d | detail                   Repeat the last show with all rows');
    console.log('  export <guardrail-id> --versions=a,b [--out=<file>]');
    console.log('                               Download a signed .guardrail.zip of those versions');
    console.log('  import <file> [--versions=a,b] [--confirm]');
    console.log('                               Verify and preview a package; --confirm imports it');
    console.log('  exit | quit                  Close the CLI');
    return;
  }

  if (cmd === 'connect') {
    if (args.length === 0) {
      console.log(`Connected to: ${session.baseUrl} (source: ${session.urlSource})`);
      console.log('Usage: connect <url>  (e.g. connect http://localhost:8080)');
      return;
    }
    let newUrl = args[0];
    if (!/^https?:\/\//.test(newUrl)) newUrl = `http://${newUrl}`;
    session.baseUrl = newUrl;
    session.urlSource = 'runtime connect';
    session.token = null;
    session.authCookie = null;
    session.privileged = false;
    console.log(`Connected to: ${session.baseUrl}`);
    return;
  }

  if (cmd === 'read') {
    if (args[0]?.startsWith('--token=')) {
      session.token = args[0].slice('--token='.length);
    } else if (process.env.GUARD_ACCESS_TOKEN) {
      session.token = process.env.GUARD_ACCESS_TOKEN;
    } else {
      const token = await promptHidden('Access token: ');
      session.token = token || '';
    }
    session.privileged = false;
    session.authCookie = null;
    if (!session.token) {
      console.log('(no token entered)');
      return;
    }
    const ident = await runApi('GET', '/api/v1/account/identity');
    if (ident.ok && ident.data) {
      const user = ident.data.user ?? ident.data;
      const role = user?.role ?? user?.roleId ?? 'member';
      const permissions = ident.data.effectivePermissions ?? ident.data.permissions;
      console.log(`Signed in: ${(user?.email ?? user?.name ?? ident.data.userId ?? 'unknown')} (${role})`);
      if (permissions && typeof permissions === 'object') {
        console.log(`Permissions: ${Object.entries(permissions).map(([module, access]) => `${module}:${access}`).join(', ')}`);
      }
    } else {
      session.token = null;
      console.error(`Token authentication failed: ${ident.error ?? `HTTP ${ident.status}`}`);
      if (!process.stdin.isTTY) process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'enable') {
    let email: string;
    let password: string | null;
    if (args[0]?.startsWith('--password=')) {
      password = args[0].slice('--password='.length);
      email = (await prompt('Admin email (blank → admin@tasklattice.local): '))?.trim() || 'admin@tasklattice.local';
    } else {
      email = (await prompt('Admin email (blank → admin@tasklattice.local): '))?.trim() || 'admin@tasklattice.local';
      password = await promptHidden('Admin password (blank → simulates local-default "admin"): ');
    }
    if (password === null || inputClosed) return;
    const pwForApi = password === '' ? 'admin' : password;
    const resp = await runApi('POST', '/api/auth/sign-in/email', {
      email,
      password: pwForApi,
    }, { withCredentials: true, omitCredentials: true });
    if (resp.ok && resp.data && !resp.data.error) {
      session.privileged = true;
      const user = resp.data?.user ?? resp.data?.identity?.user ?? {};
      console.log(`Privileged mode enabled (${String(user.email ?? email)}).`);
    } else {
      const msg = resp.data?.message ?? resp.data?.error?.message ?? `HTTP ${resp.status}`;
      console.error(`Admin sign-in failed: ${msg}`);
    }
    return;
  }

  if (cmd === 'disable') {
    session.privileged = false;
    session.authCookie = null;
    console.log('Privileged mode disabled.');
    return;
  }

  if (cmd === 'show') {
    await handleShow(args);
    return;
  }

  if (cmd === 'export') {
    await handleExport(args);
    return;
  }

  if (cmd === 'import') {
    await handleImport(args);
    return;
  }

  if (cmd === 'd' || cmd === 'detail') {
    if (!lastShowArgs) {
      console.log('No previous show command. Run show <resource> first.');
      return;
    }
    await handleShow([...lastShowArgs.filter((arg) => !arg.startsWith('--detail')), '--detail']);
    return;
  }

  console.log(`Unknown command: ${cmd}. Type 'help' for usage.`);
}

async function main() {
  console.log('Welcome to Guard Controller CLI (guardctl)');
  console.log(`Connected to: ${session.baseUrl} (via ${session.urlSource})`);
  if (process.env.GUARD_ACCESS_TOKEN) {
    session.token = process.env.GUARD_ACCESS_TOKEN;
    console.log('Using token from GUARD_ACCESS_TOKEN.');
  }
  console.log(`Type 'help' for commands or 'show' to list resources.`);
  console.log('');

  const getPrompt = () => {
    const prefix = session.privileged ? 'guardctl#' : (session.token ? 'guardctl>' : 'guardctl(disconnected)>');
    return `${prefix} `;
  };

  while (!inputClosed || inputLines.length) {
    const line = await prompt(getPrompt());
    if (line === null) break;
    await handleCommand(line);
  }
}

main().catch(error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  rl.close();
});
