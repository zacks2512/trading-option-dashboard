import { JournalError } from './repository.mjs';

export function createAPI({ verify, authorize, repository, origins }) {
  return async function fetch(request) {
    const origin = request.headers.get('origin');
    const allowed = !origin || origins.includes(origin);
    const headers = { 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin && allowed) headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    const json = (data, status = 200) => Response.json(data, { status, headers });
    if (!allowed) return json({ error: 'Origin is not allowed.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return json({ error: 'Sign in to your journal.' }, 401);
    let owner;
    try { owner = (await verify(token)).sub; if (!owner) throw new Error(); }
    catch { return json({ error: 'Your session expired. Sign in again.' }, 401); }
    try {
      if (!await authorize(owner)) return json({ error: 'This private journal is restricted to its verified owner.' }, 403);
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/snapshot') return json(await repository.load(owner));
      if (request.method === 'POST' && path === '/commit') {
        const reader = request.body?.getReader();
        if (!reader) return json({ error: 'A save request is required.' }, 400);
        const chunks = []; let bytes = 0;
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 8 * 1024 * 1024) { await reader.cancel(); return json({ error: 'Save is too large.' }, 413); }
          chunks.push(value);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json({ error: 'Invalid JSON.' }, 400); }
        return json(await repository.commit(owner, body));
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof JournalError) return json({ error: error.message }, error.status);
      // Do not send SQL, connection strings or broker data to browser/error logs.
      return json({ error: 'Journal service unavailable. Please retry later.' }, 503);
    }
  };
}
