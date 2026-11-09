import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {attachStreamTransport, checkOutputStream} from './stream-transport.mjs';

for (const outage of [false, true]) test(`WebSocket regression bridge ${outage ? 'disconnects on fault' : 'forwards ordered events'}`, async () => {
  const origin = createServer(), bridge = createServer();
  const sockets = new WebSocketServer({server: origin});
  const observed = [];
  sockets.on('connection', (socket, request) => {
    assert.equal(request.headers['x-api-key'], 'synthetic-only');
    let id, parts = [], expected = 0;
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes);
      const send = event => socket.send(JSON.stringify({stream_id: id, ...event}));
      if (frame.type === 'start') {
        id = frame.stream_id;
        send({type: 'ready', mode: 'full_buffered', version: 1, input_credits: 8});
      } else {
        assert.equal(frame.sequence, expected++);
        send({type: 'ack', sequence: frame.sequence});
        if (frame.type === 'delta') parts.push(frame.text);
        else {
          const text = parts.join('');
          send({type: 'delta', sequence: 0, text});
          send({type: 'completed', sequence: 1, released_characters: text.length, checks: 1, transformed: false});
        }
      }
    });
  });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await listen(origin);
  const closeStreams = attachStreamTransport(bridge, {
    target: () => `http://127.0.0.1:${origin.address().port}`,
    observe: event => observed.push(event),
    fault: (direction, event) => outage && direction === 'input' && event.type === 'end',
  });
  await listen(bridge);
  try {
    const work = checkOutputStream(`http://127.0.0.1:${bridge.address().port}/endpoint`, 'synthetic-only',
      {stream_id: 'test', protocol: 'litellm'}, ['中文 ', 'safe']);
    if (outage) await assert.rejects(work, /closed|transport/);
    else {
      const result = await work;
      assert.equal(result.text, '中文 safe');
      assert.equal(result.terminal.type, 'completed');
      assert.equal(observed.filter(e => e.direction === 'output' && e.event.type === 'ready').length, 1);
    }
  } finally {
    closeStreams();
    for (const socket of sockets.clients) socket.terminate();
    await Promise.all([new Promise(resolve => bridge.close(resolve)), new Promise(resolve => origin.close(resolve))]);
    sockets.close();
  }
});
