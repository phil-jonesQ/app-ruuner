import assert from 'assert';
const fetchFn = globalThis.fetch || undefined;

let ioLib;
try {
  ioLib = (await import('socket.io-client'));
} catch (e) {
  console.error('socket.io-client not installed');
  process.exit(1);
}

const BASE = process.env.BASE || 'http://127.0.0.1:2001';

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('Integration test target:', BASE);

  // connect socket
  const socket = ioLib.io(BASE, { reconnectionAttempts: 3 });

  let events = { session: null, stats: null };
  socket.on('connect', () => console.log('socket connected', socket.id));
  socket.on('session:update', (p) => { events.session = p; });
  socket.on('stats:update', (p) => { events.stats = p; });

  // ensure server reachable
  const s = await (fetchFn ? fetchFn(`${BASE}/api/stats`) : (await import('node-fetch')).default(`${BASE}/api/stats`));
  assert.strictEqual(s.status, 200, '/api/stats must return 200');
  const j = await s.json();
  console.log('initial stats', j);

  // ensure socket gets initial event
  await wait(400);
  assert.ok(events.session !== null, 'expected session:update to be emitted');

  // post launch
  const launchUrl = `${BASE}/api/launch/test-integration`;
  const l = await (fetchFn ? fetchFn(launchUrl, { method: 'POST' }) : (await import('node-fetch')).default(launchUrl, { method: 'POST' }));
  assert.ok(l.status >= 200 && l.status < 300, 'launch POST succeeded');

  // post rating
  const r = await (fetchFn ? fetchFn(`${BASE}/api/rate/test-integration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: 5 }) }) : (await import('node-fetch')).default(`${BASE}/api/rate/test-integration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: 5 }) }));
  assert.ok(r.status >= 200 && r.status < 300, 'rate POST succeeded');

  // wait for stats update over socket
  let attempts = 0;
  while ((!events.stats || !events.stats.stats) && attempts < 10) { await wait(200); attempts++; }
  const received = events.stats?.stats || null;
  assert.ok(received, 'expected stats update via socket');
  console.log('received stats update', received);

  // check our project's launch and rating are present
  assert.ok(received.launches['test-integration'] >= 1, 'launch recorded');
  assert.ok(received.ratings['test-integration'] && received.ratings['test-integration'].count >= 1, 'rating recorded');

  console.log('Integration test completed OK');
  socket.close();
  process.exit(0);
})().catch(e => { console.error('Integration test failed', e); process.exit(1); });
