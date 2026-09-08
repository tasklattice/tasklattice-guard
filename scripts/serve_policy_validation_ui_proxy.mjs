/** Real tali UI regression: delay one named local Policy's terminal validation reply. */
import { createServer } from 'node:http';

const expectedName = 'Regression desktop Policy validation race 20260908';
const state = { expectedName, policyId: null, delayed: false, waiting: false, released: false, writes: [] };
let release;
process.on('SIGUSR1', () => release?.());
const json = (res, status, value) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
function localDraft(body) {
  const draft = body.draft;
  return body.name === expectedName && draft && draft.action_references.every(item =>
    ['GuardCustomerIdentifierAction', 'GuardRecordPolicyAction'].includes(item.name) && item.version === '1.0.0') &&
    draft.evaluation_contracts.length === 0 && draft.prompt_dependencies.length === 0;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__audit' && req.method === 'GET') return json(res, 200, state);
    const parts = []; for await (const part of req) parts.push(part);
    const bytes = Buffer.concat(parts);
    const path = url.pathname;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const create = req.method === 'POST' && path === '/api/v1/policies' && !state.policyId && localDraft(JSON.parse(bytes));
      const own = state.policyId && path === `/api/v1/policies/${encodeURIComponent(state.policyId)}`;
      const update = own && req.method === 'PATCH' && localDraft(JSON.parse(bytes));
      const remove = own && req.method === 'DELETE';
      const validate = state.policyId && req.method === 'POST' &&
        ['/validate', '/validation-runs'].some(suffix => path === `/api/v1/policies/${encodeURIComponent(state.policyId)}${suffix}`);
      if (!create && !update && !remove && !validate) return json(res, 403, { error: 'Only the named local test Policy may be changed. Publication and model APIs are blocked.' });
      state.writes.push({ method: req.method, path });
    }
    const headers = { ...req.headers, host: 'localhost:38081' };
    delete headers.connection; delete headers['accept-encoding'];
    if (headers.origin) headers.origin = 'http://localhost:38081';
    const reply = await fetch(`http://localhost:38081${url.pathname}${url.search}`, {
      method: req.method, headers, ...(bytes.length ? { body: bytes } : {}), redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    const body = Buffer.from(await reply.arrayBuffer());
    if (path === '/api/v1/policies' && req.method === 'POST' && reply.status === 201) {
      state.policyId = JSON.parse(body).id;
      console.log(`Created test Policy ${state.policyId}; not published.`);
    }
    if (state.policyId && path.startsWith(`/api/v1/policies/${encodeURIComponent(state.policyId)}/validation-runs`) && reply.ok && !state.delayed) {
      const result = JSON.parse(body);
      if (['passed', 'failed'].includes(result.status)) {
        state.delayed = true; state.waiting = true;
        console.log(`Holding actual ${result.status} validation reply; SIGUSR1 releases it (30s maximum).`);
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 30_000);
          release = () => { clearTimeout(timer); resolve(); };
        });
        release = undefined; state.waiting = false; state.released = true;
      }
    }
    const outgoing = Object.fromEntries(reply.headers);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) delete outgoing[name];
    const cookies = reply.headers.getSetCookie(); if (cookies.length) outgoing['set-cookie'] = cookies;
    res.writeHead(reply.status, outgoing).end(body);
  } catch {
    if (!res.headersSent) json(res, 502, { error: 'Policy acceptance forwarding failed.' });
    else res.destroy();
  }
});
server.listen(0, '127.0.0.1', () => console.log(`Policy acceptance proxy http://localhost:${server.address().port}; pid ${process.pid}; live model APIs and publication blocked.`));
