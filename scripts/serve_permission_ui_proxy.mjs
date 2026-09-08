/** Desktop role-loss fixture: real built UI + tali reads, no account mutations. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../controller/dist/', import.meta.url));
const state = { role: 'admin', rejectedWrites: 0, forwardedPreviews: 0 };
// Optional bounded delay makes the identity-cache refill visible in desktop QA.
// It changes only this local fixture, never the upstream API or stored Policies.
const catalogDelayMs = Math.min(60_000, Math.max(0, Number(process.env.AUDIT_CATALOG_DELAY_MS) || 0));
process.on('SIGUSR1', () => {
  state.role = state.role === 'admin' ? 'user' : 'admin';
  console.log(`Fixture session role: ${state.role}. Actual account is unchanged.`);
});
const json = (res, status, value) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:38093');
    if (url.pathname === '/__audit' && req.method === 'GET') return json(res, 200, state);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health')) {
      if (req.method === 'GET' && url.pathname === '/api/v1/policies' && state.role === 'user' && catalogDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, catalogDelayMs));
      }
      const preview = req.method === 'POST' && url.pathname === '/api/v1/guardrail-plan-previews' && state.role === 'admin';
      if (req.method !== 'GET' && !preview) {
        state.rejectedWrites++;
        return json(res, 403, { error: { code: 'forbidden', message: 'Acceptance fixture: administrator permission revoked. No write was forwarded.' } });
      }
      const parts = [];
      for await (const part of req) parts.push(part);
      const body = Buffer.concat(parts);
      const headers = { ...req.headers, host: 'localhost:38081', origin: 'http://localhost:38081' };
      delete headers.connection;
      delete headers['accept-encoding'];
      if (preview) state.forwardedPreviews++;
      const reply = await fetch(`http://localhost:38081${url.pathname}${url.search}`, {
        method: req.method, headers, ...(body.length ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(15_000),
      });
      let bytes = Buffer.from(await reply.arrayBuffer());
      if (url.pathname === '/api/auth/get-session' && reply.ok && state.role === 'user') {
        const session = JSON.parse(bytes);
        if (session?.user) session.user.role = 'user';
        bytes = Buffer.from(JSON.stringify(session));
      }
      const outgoing = Object.fromEntries(reply.headers);
      for (const key of ['content-encoding', 'transfer-encoding', 'content-length', 'set-cookie']) delete outgoing[key];
      res.writeHead(reply.status, { ...outgoing, 'cache-control': 'no-store' }).end(bytes);
      return;
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Read-only fixture' });
    const path = url.pathname.startsWith('/assets/') ? resolve(root, `.${decodeURIComponent(url.pathname)}`) : resolve(root, 'index.html');
    if (!path.startsWith(resolve(root) + sep)) return json(res, 400, { error: 'Invalid path' });
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[extname(path)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(await readFile(path));
  } catch {
    if (!res.headersSent) json(res, 502, { error: 'Permission acceptance proxy failed' });
    else res.destroy();
  }
}).listen(38093, '127.0.0.1', () => console.log('Desktop permission fixture: localhost:38093; SIGUSR1 toggles synthetic session authority; all writes except plan preview are blocked.'));
