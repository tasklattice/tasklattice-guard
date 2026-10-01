/** Regression-only WebSocket bridge. It forwards real Runner events unchanged. */
import WebSocket, {WebSocketServer} from 'ws';

export function attachStreamTransport(server, {target, observe = () => {}, fault = () => false}) {
  const sockets = new Set();
  const upgrades = new WebSocketServer({noServer: true, maxPayload: 1_048_576});
  server.on('upgrade', (request, socket, head) => {
    if (!request.url.endsWith('/guardrails/output-stream')) { socket.destroy(); return; }
    const url = new URL(request.url, typeof target === "function" ? target() : target);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const upstream = new WebSocket(url, {headers: {'x-api-key': request.headers['x-api-key'] ?? ''},
      maxPayload: 1_048_576, handshakeTimeout: 10_000});
    sockets.add(upstream);
    let downstream;
    const stop = () => { upstream.terminate(); downstream?.terminate(); socket.destroy(); };
    upstream.on('error', stop);
    upstream.once('open', () => upgrades.handleUpgrade(request, socket, head, client => {
      downstream = client; sockets.add(client);
      const forward = (direction, bytes, binary, destination) => {
        try {
          const event = JSON.parse(bytes.toString());
          if (fault(direction, event)) { stop(); return; }
          observe({path: request.url, direction, at: Date.now(), event});
          if (destination.readyState === WebSocket.OPEN) destination.send(bytes, {binary});
        } catch { stop(); }
      };
      client.on('message', (data, binary) => forward('input', data, binary, upstream));
      upstream.on('message', (data, binary) => forward('output', data, binary, client));
      client.on('error', stop);
      client.on('close', () => { sockets.delete(client); upstream.close(); });
      upstream.on('close', () => { sockets.delete(upstream); client.close(); });
    }));
    upstream.once('close', () => { sockets.delete(upstream); if (!downstream) socket.destroy(); });
  });
  return () => { for (const socket of sockets) socket.terminate(); upgrades.close(); };
}

/** One-credit peer used by direct regression scripts, including full buffering. */
export async function checkOutputStream(endpoint, credential, start, parts) {
  const socket = new WebSocket(endpoint.replace(/^http/, 'ws') + '/guardrails/output-stream', {
    headers: {'x-api-key': credential}, maxPayload: 1_048_576, handshakeTimeout: 10_000});
  const events = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(Error('Output stream timed out')); }, 300_000);
    let sequence = 0, ready;
    const finish = (error, result) => {
      clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(result);
    };
    const send = () => socket.send(JSON.stringify(sequence < parts.length
      ? {type: 'delta', sequence, text: parts[sequence++]}
      : {type: 'end', sequence: sequence++}));
    socket.on('open', () => socket.send(JSON.stringify({type: 'start', version: 1, ...start})));
    socket.on('message', bytes => {
      try {
        const event = JSON.parse(bytes); events.push(event);
        if (event.stream_id !== start.stream_id) throw Error('Invalid stream identity');
        if (event.type === 'ready') { ready = event; send(); }
        else if (event.type === 'ack') {
          if (event.sequence !== sequence - 1) throw Error('Invalid input sequence');
          if (sequence <= parts.length) send();
        } else if (['completed', 'blocked', 'error'].includes(event.type)) {
          finish(null, {ready, terminal: event, events,
            text: events.filter(e => e.type === 'delta').map(e => e.text).join('')});
        }
      } catch (error) { finish(error); }
    });
    socket.on('error', () => finish(Error('Output stream transport failed')));
    socket.on('close', () => { clearTimeout(timer); reject(Error('Output stream closed before completion')); });
  });
}
