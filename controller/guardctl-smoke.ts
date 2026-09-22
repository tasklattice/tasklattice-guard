import axios from 'axios';

const baseUrl = process.env.GUARD_URL || 'http://localhost:8080';
let authCookie: string | null = null;

async function req(method: string, path: string, data?: any) {
  const headers: Record<string, string> = {};
  if (authCookie) headers.Cookie = authCookie;
  const resp = await axios({
    method,
    url: `${baseUrl}${path}`,
    data,
    headers,
    validateStatus: () => true,
  });
  const setCookies = (resp.headers as any)['set-cookie'];
  if (Array.isArray(setCookies) && setCookies.length) {
    authCookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  }
  return { status: resp.status, data: resp.data };
}

const okLog: string[] = [];
const badLog: string[] = [];

function record(name: string, r: { status: number; data: any }) {
  if (r.status >= 200 && r.status < 300) {
    const hint = Array.isArray(r.data) ? `[${r.data.length}]` :
      typeof r.data === 'object' && r.data ? `{${Object.keys(r.data).slice(0, 4).join(',')}}` : '';
    okLog.push('OK: ' + name + (hint ? ' ' + hint : ''));
  } else if (r.status === 401 || r.status === 403) {
    okLog.push('OK: ' + name + ' (' + r.status + ' -- auth required)');
  } else if (r.status === 404) {
    badLog.push('MISSING: ' + name + ' (404 endpoint missing)');
  } else {
    badLog.push('FAIL: ' + name + ' (' + r.status + ': ' + JSON.stringify(r.data).slice(0, 120) + ')');
  }
}

async function main() {
  console.log('=== guardctl read smoke test to ' + baseUrl + ' ===');

  const anonymousCommands: Array<[string, string]> = [
    ['show system', 'GET /api/v1/system/status'],
    ['show providers', 'GET /api/v1/model-providers'],
    ['show models', 'GET /api/v1/models'],
    ['show selector-fields', 'GET /api/v1/routing/selector-fields'],
    ['show policies', 'GET /api/v1/policies'],
    ['show guardrails', 'GET /api/v1/guardrails'],
    ['show endpoints', 'GET /api/v1/endpoints'],
    ['show routers', 'GET /api/v1/routers'],
    ['show runner-pools', 'GET /api/v1/runner-pools'],
    ['show runners', 'GET /api/v1/runner-pools'],
    ['show model-configuration', 'GET /api/v1/model-configuration'],
    ['show protection-presets', 'GET /api/v1/policy-catalog/protection-presets'],
    ['show actions', 'GET /api/v1/policy-catalog/actions'],
    ['show telemetry-events', 'GET /api/v1/telemetry/events'],
    ['show telemetry-metrics', 'GET /api/v1/telemetry/metrics'],
    ['show endpoint-activity', 'GET /api/v1/telemetry/endpoint-activity'],
    ['show audit-events', 'GET /api/v1/audit-events'],
    ['show identity', 'GET /api/v1/account/identity'],
    ['show access-tokens', 'GET /api/v1/account/access-tokens'],
    ['show validation-runs', 'GET /api/v1/validation-runs'],
  ];
  for (const [name, pathStr] of anonymousCommands) {
    const [m, p] = pathStr.split(' ');
    record(name, await req(m, p));
  }

  const signin = await req('POST', '/api/auth/sign-in/email', {
    email: 'admin@tasklattice.local',
    password: 'admin',
  });
  if (signin.status >= 200 && signin.status < 300 && !signin.data?.error) {
    okLog.push('OK: enable (admin sign-in OK as ' + (signin.data?.user?.email ?? 'admin@tasklattice.local') + ')');
  } else {
    badLog.push('FAIL: enable failed (' + signin.status + '): ' + JSON.stringify(signin.data).slice(0, 200));
  }

  const authed: Array<[string, string]> = [
    ['show identity (authed)', 'GET /api/v1/account/identity'],
    ['show access-tokens (authed)', 'GET /api/v1/account/access-tokens'],
  ];
  for (const [name, pathStr] of authed) {
    const [m, p] = pathStr.split(' ');
    record(name, await req(m, p));
  }

  const guardrailsResp = await req('GET', '/api/v1/guardrails');
  const grId = Array.isArray(guardrailsResp.data) ? guardrailsResp.data[0]?.id : null;
  const policiesResp = await req('GET', '/api/v1/policies');
  const polId = Array.isArray(policiesResp.data) ? policiesResp.data[0]?.id : null;
  const routersResp = await req('GET', '/api/v1/routers');
  const rtrId = Array.isArray(routersResp.data) ? routersResp.data[0]?.id : null;
  const poolsResp = await req('GET', '/api/v1/runner-pools');
  const poolId = Array.isArray(poolsResp.data) ? poolsResp.data[0]?.id : null;

  if (grId) {
    record('show guardrail <id>', await req('GET', '/api/v1/guardrails/' + encodeURIComponent(grId)));
    record('show guardrail-logging <id>', await req('GET', '/api/v1/guardrails/' + encodeURIComponent(grId) + '/logging'));
    record('show test-cases <guardrail-id>', await req('GET', '/api/v1/guardrails/' + encodeURIComponent(grId) + '/test-cases'));
  }
  if (polId) {
    record('show policy-validation <policy-id>', await req('GET', '/api/v1/policies/' + encodeURIComponent(polId) + '/validation-runs/latest'));
    record('show policies <id>', await req('GET', '/api/v1/policies/' + encodeURIComponent(polId)));
  }
  if (rtrId) {
    record('show routers <id>', await req('GET', '/api/v1/routers/' + encodeURIComponent(rtrId)));
    record('show router-revisions <router-id>', await req('GET', '/api/v1/routers/' + encodeURIComponent(rtrId) + '/revisions'));
    record('show routes <router-id>', await req('GET', '/api/v1/routers/' + encodeURIComponent(rtrId)));
    record('show route-distribution <router-id>', await req('GET', '/api/v1/routers/' + encodeURIComponent(rtrId) + '/traffic-distribution'));
  }
  if (poolId) {
    record('show runner-pool <id>', await req('GET', '/api/v1/runner-pools/' + encodeURIComponent(poolId)));
  }

  console.log('\n--- Passed / Expected OK ---');
  okLog.forEach((l) => console.log(l));
  if (badLog.length) {
    console.log('\n--- Issues / Missing ---');
    badLog.forEach((l) => console.log(l));
  }
  console.log('\n=== Totals: ' + okLog.length + ' OK / ' + badLog.length + ' issues ===');
  process.exit(badLog.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e?.message ?? e);
  process.exit(2);
});
