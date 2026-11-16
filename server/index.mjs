import pg from 'pg';
import { attachDatabasePool } from '@neon/functions';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createAPI } from './api.mjs';
import { createRepository } from './repository.mjs';

for (const name of ['DATABASE_URL', 'NEON_AUTH_BASE_URL', 'NEON_AUTH_JWKS_URL', 'OWNER_EMAIL']) {
  if (!process.env[name]) throw new Error(`Required server configuration missing: ${name}`);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
attachDatabasePool(pool);
const jwks = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL));
const issuer = new URL(process.env.NEON_AUTH_BASE_URL).origin;
export default {
  fetch: createAPI({
    verify: async token => (await jwtVerify(token, jwks, { issuer, algorithms: ['EdDSA'] })).payload,
    authorize: async owner => {
      const { rows } = await pool.query('SELECT email, "emailVerified" AS verified FROM neon_auth."user" WHERE id=$1', [owner]);
      return rows.length === 1 && rows[0].verified === true && rows[0].email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase();
    },
    repository: createRepository(pool),
    origins: ['https://zacks2512.github.io', 'http://localhost:3000', 'http://127.0.0.1:3000'],
  }),
};
