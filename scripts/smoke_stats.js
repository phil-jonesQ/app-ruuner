let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    fetchFn = require('node-fetch');
  } catch (e) {
    console.error('node-fetch not available and global fetch not found — please use Node 18+ or install node-fetch.');
    process.exit(1);
  }
}

const BASE = process.env.BASE || 'http://127.0.0.1:2001';
(async () => {
  console.log('Running smoke tests against', BASE);
  try {
    const s1 = await fetchFn(`${BASE}/api/stats`);
    console.log('/api/stats', s1.status);
    const j1 = await s1.json();
    console.log('Initial stats', j1);

    console.log('POST /api/launch/test-app');
    const l = await fetchFn(`${BASE}/api/launch/test-app`, { method: 'POST' });
    console.log('launch status', l.status);

    console.log('POST /api/rate/test-app -> 4');
    const r = await fetchFn(`${BASE}/api/rate/test-app`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: 4 }) });
    console.log('rate status', r.status);

    const s2 = await fetchFn(`${BASE}/api/stats`);
    const j2 = await s2.json();
    console.log('Updated stats', j2);

    console.log('Smoke tests completed');
  } catch (e) {
    console.error('Smoke tests failed', e);
    process.exit(1);
  }
})();
