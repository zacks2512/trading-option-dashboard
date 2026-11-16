const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const S = require('../journal-store.js');
const request = (path, token, body, origin = 'https://zacks2512.github.io') => new Request(`https://journal.test${path}`, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: origin }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('Vercel access is limited to explicitly configured HTTPS origins', async () => {
  const { allowedOrigins } = await import('../server/origins.mjs');
  const { createAPI } = await import('../server/api.mjs');
  const origins = allowedOrigins('https://my-journal.vercel.app,http://localhost:3000');
  const api = createAPI({ verify: async () => ({ sub: 'owner' }), authorize: async () => true, repository: { load: async () => ({ initialized: false }) }, origins });
  assert.equal((await api(request('/snapshot', 'owner', undefined, 'https://my-journal.vercel.app'))).status, 200);
  assert.equal((await api(request('/snapshot', 'owner', undefined, 'https://another-project.vercel.app'))).status, 403);
  for (const value of ['https://*.vercel.app', 'http://public.example', 'https://user:password@example.com', 'https://example.com/path']) assert.throws(() => allowedOrigins(value));
});

test('Neon API authenticates and authorizes before accessing journal data', async () => {
  const { createAPI } = await import('../server/api.mjs');
  let reads = 0;
  const api = createAPI({ verify: async token => { if (token === 'invalid') throw Error(); return { sub: token }; }, authorize: async id => id === 'owner', repository: { load: async () => { reads++; return { initialized: false }; } }, origins: ['https://zacks2512.github.io'] });
  assert.equal((await api(request('/snapshot'))).status, 401);
  assert.equal((await api(request('/snapshot', 'invalid'))).status, 401);
  assert.equal((await api(request('/snapshot', 'another-user'))).status, 403);
  assert.equal((await api(request('/snapshot', 'owner', undefined, 'https://evil.test'))).status, 403);
  assert.equal(reads, 0);
  const response = await api(request('/snapshot', 'owner'));
  assert.equal(response.status, 200); assert.equal(reads, 1);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://zacks2512.github.io');
});

test('Neon save response recovery locks further writes when status is unknown', async () => {
  const { createNeonStore } = await import('../client/store.mjs');
  const { snapshot } = await import('../server/repository.mjs');
  let transactionId, saved = false, recovered = false;
  const Store = createNeonStore(S.Store, async (path, body) => {
    if (body) { transactionId = body.transactionId; saved = true; const e = Error('Lost response'); e.uncertain = true; throw e; }
    const state = snapshot([]);
    if (saved && recovered) state.data.history.records.push({ transactionId });
    return state;
  });
  const db = new Store();
  await assert.rejects(db.commit([{ table: 'accounts', id: 'a', data: { id: 'a' } }]));
  assert.equal(db.uncertain, true);
  await assert.rejects(db.commit([{ table: 'accounts', id: 'a', data: { id: 'a' } }]), /Reload/);
  recovered = true; saved = false;
  const db2 = new Store();
  const result = await db2.commit([{ table: 'accounts', id: 'a', data: { id: 'a' } }]);
  assert.equal(result.recovered, true); assert.equal(db2.uncertain, false);
});

test('Neon validates stale changes, reserved fields and impossible fills on the server', async () => {
  const { validateCommit } = await import('../server/repository.mjs');
  const db = new S.Store();
  const save = mutations => ({ transactionId: randomUUID(), mutations });
  assert.throws(() => validateCommit(db, save([{ table: 'history', id: 'x', data: {} }])), /Invalid/);
  assert.throws(() => validateCommit(db, save([{ table: 'accounts', id: 'x', data: { _rev: 2 } }])), /Invalid/);
  assert.throws(() => validateCommit(db, save([{ table: 'accounts', id: 'x', expected: '9:x', data: {} }])), /changed/);
  const trade = { id: 't', title: 'Call', symbol: 'XYZ', accountId: 'a', mode: 'package', side: 'long', structure: 'Long Call', strike: 100, expiry: '2026-12-18', entryDate: '2026-11-01', multiplier: 100, contractsPerPackage: 1 };
  assert.throws(() => validateCommit(db, save([
    { table: 'accounts', id: 'a', data: { name: 'Main' } },
    { table: 'trades', id: 't', data: trade },
    { table: 'actions', id: 'o', data: { tradeId: 't', kind: 'open', date: '2026-11-01', fills: [{ unitId: 'package', quantity: 1, price: 2 }], feeMode: 'actual', fee: 0 } },
    { table: 'actions', id: 'c', data: { tradeId: 't', kind: 'close', date: '2026-11-02', fills: [{ unitId: 'package', quantity: 2, price: 3 }], feeMode: 'actual', fee: 0 } },
  ])), /Cannot close/);
});

test('Postgres atomic revisions, ownership, rollback, concurrent edits and idempotency', { skip: process.env.JOURNAL_TEST_POSTGRES !== '1' }, async () => {
  const { Pool } = require('pg');
  const { createRepository } = await import('../server/repository.mjs');
  // This opt-in suite only ever connects to the disposable local test container.
  const pool = new Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', database: 'postgres' });
  const owner = randomUUID(), other = randomUUID(), repository = createRepository(pool);
  const mutation = (table, id, data, expected = '') => ({ table, id, data, expected });
  const save = mutations => ({ transactionId: randomUUID(), mutations });
  try {
    const first = save([mutation('accounts', 'a', { name: 'Main' }), mutation('settings', 'feeRate', { value: 0.65 })]);
    await repository.commit(owner, first);
    assert.equal((await repository.commit(owner, first)).recovered, true);
    const initial = await repository.load(owner), db = new S.Store(); db.data = initial.data;
    assert.equal(initial.data.history.records.length, 2);
    assert.equal((await repository.load(other)).data.accounts.records.length, 0);
    const expected = S.version(db.get('accounts', 'a'));
    const results = await Promise.allSettled([
      repository.commit(owner, save([mutation('accounts', 'a', { name: 'One' }, expected)])),
      repository.commit(owner, save([mutation('accounts', 'a', { name: 'Two' }, expected)])),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    await assert.rejects(repository.commit(owner, save([mutation('accounts', 'new', { name: 'Should roll back' }), mutation('accounts', 'a', { name: 'Stale' }, expected)])), /changed/);
    const state = await repository.load(owner);
    assert.equal(state.data.accounts.records.length, 1);
    assert.equal(state.data.accounts.versions.length, 2);
    assert.equal(state.data.history.records.length, 3);
    await assert.rejects(repository.commit(owner, { ...first, note: 'Different payload' }), /already used/);
    const current = state.data.accounts.records[0];
    await repository.commit(owner, save([{ ...mutation('accounts', 'a', { name: current.name }, S.version(current)), deleted: true }]));
    const deleted = (await repository.load(owner)).data.accounts.records[0];
    assert.equal(deleted._deleted, true);
    await repository.commit(owner, save([mutation('accounts', 'a', { name: current.name }, S.version(deleted))]));
    assert.equal((await repository.load(owner)).data.accounts.records[0]._deleted, false);
  } finally {
    await pool.query('DELETE FROM trading_journal.revisions WHERE owner_id=$1', [owner]);
    await pool.query('DELETE FROM trading_journal.commits WHERE owner_id=$1', [owner]);
    await pool.end();
  }
});
