import { createHash, randomUUID } from 'node:crypto';
import StoreAPI from '../journal-store.js';
import Engine from '../journal-engine.js';
import { migration } from './schema.mjs';

export class JournalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function snapshot(rows) {
  const data = {};
  for (const name of Object.keys(StoreAPI.TABLES)) {
    const cells = [StoreAPI.HEADER, ...rows.filter(r => r.entity === name).map(r => [
      r.record_id, r.revision, r.change_id, new Date(r.updated_at).toISOString(), r.deleted, JSON.stringify(r.data),
    ])];
    data[name] = StoreAPI.parseRows(cells, name);
  }
  return { data, initialized: data.accounts.records.some(r => !r._deleted) };
}

export function validateCommit(db, body) {
  if (!body || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.transactionId || ''))
    throw new JournalError('Invalid transaction ID.');
  const { mutations, guards = [], note = 'Saved from dashboard' } = body;
  if (!Array.isArray(mutations) || !mutations.length || mutations.length > 2000 || !Array.isArray(guards) || guards.length > 2000 || typeof note !== 'string' || note.length > 1000)
    throw new JournalError('Invalid save request.');
  for (const guard of guards) {
    if (!guard || typeof guard.id !== 'string' || typeof guard.fingerprint !== 'string') throw new JournalError('Invalid trade guard.');
    if (db.fingerprint(guard.id) !== guard.fingerprint) throw new JournalError('This trade changed in another window. Reload and review.', 409);
  }
  const seen = new Set();
  for (const m of mutations) {
    if (!m || !Object.hasOwn(StoreAPI.TABLES, m.table) || m.table === 'history' || typeof m.id !== 'string' || !m.id || m.id.length > 200 ||
        !m.data || typeof m.data !== 'object' || Array.isArray(m.data) || Object.keys(m.data).some(k => k.startsWith('_')) ||
        (m.data.id && m.data.id !== m.id) || (m.deleted !== undefined && typeof m.deleted !== 'boolean') || JSON.stringify(m.data).length > 40000)
      throw new JournalError('Invalid journal record.');
    const key = `${m.table}:${m.id}`;
    if (seen.has(key)) throw new JournalError('Duplicate record in save.');
    seen.add(key);
    if (StoreAPI.version(db.get(m.table, m.id)) !== (m.expected || '')) throw new JournalError('This record changed elsewhere. Reload and review.', 409);
    if (m.table === 'trades' && db.get('trades', m.id) && db.get('trades', m.id).mode !== m.data.mode && db.all('actions').some(a => a.tradeId === m.id))
      throw new JournalError('Accounting mode cannot change after the first execution.');
  }
  const state = {};
  for (const name of Object.keys(StoreAPI.TABLES)) {
    state[name] = new Map(db.all(name).map(r => [r.id, r]));
    for (const m of mutations.filter(m => m.table === name)) {
      if (m.deleted) state[name].delete(m.id); else state[name].set(m.id, { ...m.data, id: m.id });
    }
  }
  try {
    for (const name of ['legs', 'actions', 'quotes']) for (const record of state[name].values())
      if (!state.trades.has(record.tradeId) && !db.get('trades', record.tradeId) && !mutations.some(m => m.table === 'trades' && m.id === record.tradeId)) throw new Error('An execution, leg or quote refers to a missing trade.');
    for (const quote of state.quotes.values()) Engine.number(quote.price, 'Quote price');
    for (const trade of state.trades.values()) {
      if (!state.accounts.has(trade.accountId)) throw new Error('Trade account is missing.');
      const related = name => [...state[name].values()].filter(r => r.tradeId === trade.id);
      Engine.summarize(trade, related('legs'), related('actions'), related('quotes'), { feeRate: state.settings.get('feeRate')?.value || 0 });
    }
  } catch (error) { throw new JournalError(error.message); }
  return { mutations, note };
}

export function createRepository(pool) {
  let ready;
  async function ensureSchema() {
    // Serialize the first migration across isolates; CREATE IF NOT EXISTS alone can race.
    if (!ready) ready = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('trading_journal_schema_v1'))");
        await client.query(migration);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    })().catch(error => { ready = undefined; throw error; });
    await ready;
  }
  async function read(client, owner) {
    const { rows } = await client.query('SELECT * FROM trading_journal.revisions WHERE owner_id = $1 ORDER BY updated_at, revision', [owner]);
    return snapshot(rows);
  }
  return {
    async load(owner) { await ensureSchema(); return read(pool, owner); },
    async commit(owner, body) {
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`journal:${owner}`]);
        const state = await read(client, owner), db = new StoreAPI.Store();
        db.data = state.data;
        if (!body || typeof body.transactionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.transactionId)) throw new JournalError('Invalid transaction ID.');
        const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        // Handle lost-response replay before version checks against the new state.
        const previous = await client.query('SELECT body_hash FROM trading_journal.commits WHERE owner_id=$1 AND transaction_id=$2', [owner, body.transactionId]);
        if (previous.rows.length) {
          if (previous.rows[0].body_hash !== hash) throw new JournalError('Transaction ID already used for a different save.', 409);
          await client.query('COMMIT'); return { transactionId: body.transactionId, recovered: true };
        }
        const { mutations, note } = validateCommit(db, body);
        const at = new Date().toISOString();
        const insert = async (entity, id, rev, deleted, data) => client.query(
          'INSERT INTO trading_journal.revisions (owner_id,entity,record_id,revision,change_id,updated_at,deleted,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [owner, entity, id, rev, body.transactionId, at, deleted, JSON.stringify(data)],
        );
        for (const m of mutations) {
          const before = db.get(m.table, m.id), after = { ...m.data, id: m.id };
          await insert(m.table, m.id, (before?._rev || 0) + 1, Boolean(m.deleted), after);
          const id = randomUUID();
          await insert('history', id, 1, false, { id, entity: m.table, recordId: m.id, before: StoreAPI.plain(before), beforeDeleted: Boolean(before?._deleted), after, afterDeleted: Boolean(m.deleted), transactionId: body.transactionId, note });
        }
        await client.query('INSERT INTO trading_journal.commits VALUES ($1,$2,$3)', [owner, body.transactionId, hash]);
        await client.query('COMMIT');
        return { transactionId: body.transactionId };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  };
}
