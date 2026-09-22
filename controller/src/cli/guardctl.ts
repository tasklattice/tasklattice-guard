import readline from 'readline';
import axios, { AxiosRequestConfig } from 'axios';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    resolve(__dirname, '../../..'),
    resolve(__dirname, '../..'),
    resolve(__dirname, '..'),
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

function buildQs(flags: Record<string, string>, allowList: string[]): string {
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
      { label: 'VERSION', value: (r) => r.activeVersion ?? r.version }, { label: 'UPDATED', value: (r) => r.updatedAt },
    ],
    guardrails: [
      { label: 'ID', value: (r) => r.id }, { label: 'NAME', value: (r) => r.name }, { label: 'STATUS', value: (r) => r.status },
      { label: 'ACTIVE VERSION', value: (r) => r.activeVersion }, { label: 'DRAFT', value: (r) => r.draftRevision },
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
      { label: 'ORDER', value: (r) => r.order ?? r.routeOrder }, { label: 'TARGETS', value: (r) => r.targets?.length ?? 0 },
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

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function promptHidden(text: string): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode?.(true);
    let value = '';
    process.stdout.write(text);
    const onData = (buf: Buffer) => {
      const data = buf.toString('utf-8');
      for (const ch of data) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          process.stdin.setRawMode?.(wasRaw ?? false);
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        } else if (ch === '\u0003') {
          process.stdin.setRawMode?.(wasRaw ?? false);
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve('');
        } else if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function prompt(text: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(text, (answer) => resolve(answer));
  });
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
      return { ok: true, status: response.status, data: response.data as any };
    }
    return { ok: false, status: response.status, data: response.data as any };
  } catch (error: any) {
    return { ok: false, status: -1, error: error.message as string };
  }
}

async function handleShow(args: string[]) {
  if (args.length === 0) {
    console.log('Usage: show <resource> [<id>] [--flags...]');
    console.log('Resources:');
    console.log('  system  | identity | access-tokens');
    console.log('  providers | models | model-configuration');
    console.log('  policies [<id>] | policy-validation <policy-id> [<run-id>]');
    console.log('  protection-presets | actions');
    console.log('  guardrails [<id>] | guardrail-logging <id> | test-cases <guardrail-id>');
    console.log('  validation-runs [--guardrail <id>]');
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
    case 'policy-validation':
      if (!p1) {
        console.log('Usage: show policy-validation <policy-id> [<run-id>]');
        return;
      }
      if (p2) {
        res = await runApi('GET', `/api/v1/policies/${encodeURIComponent(p1)}/validation-runs/${encodeURIComponent(p2)}`);
      } else {
        res = await runApi('GET', `/api/v1/policies/${encodeURIComponent(p1)}/validation-runs/latest`);
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
    case 'validation-runs': {
      const qs = buildQs(flags, ['guardrail']);
      res = await runApi('GET', `/api/v1/validation-runs${qs}`);
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
        const routes = res.data.routes ?? res.data.draft?.routes ?? res.data.active?.routes ?? null;
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
      const window = flags.window;
      const revision = flags.revision;
      const qs = buildQs({ endpoint: ep, window, revision }, ['endpoint', 'window', 'revision']);
      if (routeId) {
        res = await runApi('GET', `/api/v1/routers/${encodeURIComponent(p1)}/routes/${encodeURIComponent(routeId)}/traffic-distribution${qs}`);
      } else {
        res = await runApi('GET', `/api/v1/routers/${encodeURIComponent(p1)}/traffic-distribution${qs}`);
      }
      break;
    }
    case 'selector-fields': {
      const qs = buildQs(flags, ['endpoints']);
      res = await runApi('GET', `/api/v1/routing/selector-fields${qs}`);
      break;
    }
    case 'runner-pools':
      res = await runApi('GET', `/api/v1/runner-pools${p1 ? '/' + encodeURIComponent(p1) : ''}`);
      break;
    case 'runners': {
      const qs = buildQs(flags, ['pool']);
      res = await runApi('GET', `/api/v1/runner-pools${qs}`);
      break;
    }
    case 'telemetry-events': {
      const qs = buildQs(flags, ['router', 'route', 'target', 'endpoint', 'guardrail', 'request', 'since', 'before', 'cursor', 'limit']);
      res = await runApi('GET', `/api/v1/telemetry/events${qs}`);
      break;
    }
    case 'telemetry-event':
      if (!p1) { console.log('Usage: show telemetry-event <event-id>'); return; }
      res = await runApi('GET', `/api/v1/telemetry/events/${encodeURIComponent(p1)}`);
      break;
    case 'telemetry-metrics': {
      const qs = buildQs(flags, ['router', 'guardrail', 'window']);
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
    console.error(`Network Error: ${res.error}`);
  } else {
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
    process.exit(0);
  }

  if (cmd === 'help') {
    console.log('Commands:');
    console.log('  connect [<url>]              View or change Controller URL');
    console.log('  read                         Authenticate with PAT (read-only)');
    console.log('  enable                       Sign in as administrator');
    console.log('  disable                      Drop back to read-only credentials');
    console.log('  show <resource> ...          Read a resource; run "show" for list');
    console.log('  d | detail                   Repeat the last show with all rows');
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
      const mods = ident.data.modulePermissions ?? ident.data.grants ?? [];
      console.log(`Signed in: ${(user?.email ?? user?.name ?? 'unknown')} (${role})`);
      if (Array.isArray(mods) && mods.length) {
        console.log(`Permissions: ${mods.slice(0, 8).map((m: any) => typeof m === 'string' ? m : (m.module ?? '')).filter(Boolean).join(', ')}${mods.length > 8 ? ', …' : ''}`);
      }
    } else {
      console.log('Token stored (could not fetch identity).');
    }
    return;
  }

  if (cmd === 'enable') {
    let email: string;
    let password: string;
    if (args[0]?.startsWith('--password=')) {
      password = args[0].slice('--password='.length);
      email = (await prompt('Admin email (blank → admin@tasklattice.local): ')).trim() || 'admin@tasklattice.local';
    } else {
      email = (await prompt('Admin email (blank → admin@tasklattice.local): ')).trim() || 'admin@tasklattice.local';
      password = await promptHidden('Admin password (blank → simulates local-default "admin"): ');
    }
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

  const loop = async () => {
    const line = await prompt(getPrompt());
    await handleCommand(line);
    setImmediate(loop);
  };

  loop();
}

main();
