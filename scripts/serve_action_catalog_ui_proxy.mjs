/** Read-only desktop fixture: fail Action catalog reads, then restore real tali data. */
import { createServer } from 'node:http';

const state = { unavailable: true, failedCatalogReads: 0, restoredCatalogReads: 0, rejectedWrites: 0 };
process.on('SIGUSR1', () => { state.unavailable = false; console.log('Action catalog restored; subsequent reads reach tali.'); });
const json = (res, status, value) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!['GET', 'HEAD'].includes(req.method)) {
      state.rejectedWrites++;
      return json(res, 403, { error: { code: 'forbidden', message: 'Read-only desktop fixture: no writes or model calls are forwarded.' } });
    }
    if (url.pathname === '/__audit') return json(res, 200, state);
    if (url.pathname === '/api/v1/actions') {
      if (state.unavailable) {
        state.failedCatalogReads++;
        return json(res, 503, { error: { code: 'service_unavailable', message: 'Synthetic Action catalog outage for desktop regression.' } });
      }
      state.restoredCatalogReads++;
    }
    const headers = { ...req.headers, host: 'localhost:38081' };
    delete headers.connection; delete headers['accept-encoding'];
    if (headers.origin) headers.origin = 'http://localhost:38081';
    const reply = await fetch(`http://localhost:38081${url.pathname}${url.search}`, {
      method: req.method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    const bytes = Buffer.from(await reply.arrayBuffer());
    const outgoing = Object.fromEntries(reply.headers);
    for (const key of ['content-length', 'content-encoding', 'transfer-encoding', 'set-cookie']) delete outgoing[key];
    res.writeHead(reply.status, { ...outgoing, 'cache-control': 'no-store' }).end(bytes);
  } catch {
    if (!res.headersSent) json(res, 502, { error: { message: 'Action catalog fixture forwarding failed.' } });
    else res.destroy();
  }
});
server.listen(0, '127.0.0.1', () => console.log(`Action catalog fixture http://localhost:${server.address().port}; pid ${process.pid}; SIGUSR1 restores reads; all writes blocked.`));
