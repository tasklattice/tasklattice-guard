/** Forward a named local Policy only; inject detail-read or committed-response loss. */
import { createServer } from 'node:http';

const expectedName = 'Regression desktop publication recovery 20260908';
const dropPublicationResponse = process.argv.includes('--drop-publish-response');
const state = { expectedName, policyId: null, validationPassed: false, publicationCount: 0,
  publishedVersion: null, expectedDraftRevision: null, responseDropped: false,
  failDetails: !dropPublicationResponse, failedReads: 0, restoredReads: 0, rejectedWrites: 0, writes: [] };
process.on('SIGUSR1', () => { state.failDetails = false; console.log('Published detail reads restored.'); });
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
    const ownPath = state.policyId && `/api/v1/policies/${encodeURIComponent(state.policyId)}`;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const create = req.method === 'POST' && path === '/api/v1/policies' && !state.policyId && localDraft(JSON.parse(bytes));
      const update = path === ownPath && req.method === 'PATCH' && !state.publicationCount && localDraft(JSON.parse(bytes));
      const remove = path === ownPath && req.method === 'DELETE';
      const validate = ownPath && req.method === 'POST' && !state.publicationCount &&
        ['/validate', '/validation-runs'].some(suffix => path === `${ownPath}${suffix}`);
      const publication = ownPath && req.method === 'POST' && path === `${ownPath}/publish` ? JSON.parse(bytes) : null;
      const publish = publication && state.validationPassed && state.publicationCount < (dropPublicationResponse ? 2 : 1) &&
        Number.isInteger(publication.expectedDraftRevision) && publication.expectedDraftRevision > 0 &&
        (state.expectedDraftRevision === null || publication.expectedDraftRevision === state.expectedDraftRevision);
      if (!create && !update && !remove && !validate && !publish) {
        state.rejectedWrites++;
        return json(res, 403, { error: { message: 'Only the named local test Policy and one validated publication are allowed.' } });
      }
      if (publish) state.expectedDraftRevision = publication.expectedDraftRevision;
      state.writes.push({ method: req.method, path });
    }
    if (req.method === 'GET' && path === ownPath && state.publicationCount) {
      if (state.failDetails) { state.failedReads++; return json(res, 503, { error: { message: 'Synthetic published detail read outage; publication already succeeded.' } }); }
      state.restoredReads++;
    }
    const headers = { ...req.headers, host: 'localhost:38081' };
    delete headers.connection; delete headers['accept-encoding'];
    if (headers.origin) headers.origin = 'http://localhost:38081';
    const reply = await fetch(`http://localhost:38081${url.pathname}${url.search}`, {
      method: req.method, headers, ...(bytes.length ? { body: bytes } : {}), redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    const body = Buffer.from(await reply.arrayBuffer());
    if (path === '/api/v1/policies' && req.method === 'POST' && reply.status === 201) state.policyId = JSON.parse(body).id;
    if (ownPath && path.startsWith(`${ownPath}/validation-runs`) && reply.ok && JSON.parse(body).status === 'passed') state.validationPassed = true;
    if (path === `${ownPath}/publish` && reply.status === 201) {
      state.publicationCount++; state.publishedVersion = JSON.parse(body).version;
      if (dropPublicationResponse && !state.responseDropped) {
        state.responseDropped = true;
        return json(res, 502, { error: { message: 'Synthetic response loss after committed publication; retry the same draft revision.' } });
      }
    }
    const outgoing = Object.fromEntries(reply.headers);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) delete outgoing[name];
    const cookies = reply.headers.getSetCookie(); if (cookies.length) outgoing['set-cookie'] = cookies;
    res.writeHead(reply.status, outgoing).end(body);
  } catch {
    if (!res.headersSent) json(res, 502, { error: { message: 'Publication fixture forwarding failed.' } });
    else res.destroy();
  }
});
server.listen(0, '127.0.0.1', () => console.log(`Publication fixture http://localhost:${server.address().port}; pid ${process.pid}; SIGUSR1 restores reads; model APIs blocked.`));
