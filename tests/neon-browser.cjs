// End-to-end Neon storage flow: real Postgres and real browser/auth SDK;
// only Neon identity transport is replaced, never a user's credentials.
const { chromium } = require('playwright');
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const { createAPI } = await import('../server/api.mjs');
  const { createRepository } = await import('../server/repository.mjs');
  const pool = new Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', database: 'postgres' });
  const owner = randomUUID(), repository = createRepository(pool);
  const api = createAPI({ verify: async token => { if (token !== 'TEST_OWNER_TOKEN') throw Error(); return { sub: owner }; }, authorize: async id => id === owner, repository, origins: ['https://journal.test'] });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.JOURNAL_BROWSER_EXECUTABLE || '/usr/bin/chromium' });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let signedIn = false;
    const authPaths = [];
    const session = () => signedIn ? { user: { id: owner, email: 'owner@example.test', emailVerified: true, name: 'Owner', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, session: { id: 'test-session', userId: owner, expiresAt: new Date(Date.now() + 3600000).toISOString(), token: 'TEST_SESSION' } } : null;
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://cdnjs.cloudflare.com/**', async route => route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js')) }));
    await page.route('https://auth.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      authPaths.push(pathname);
      const headers = { 'access-control-allow-origin': 'https://journal.test', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type,authorization,neon-auth-session-verifier,x-neon-client-info', 'access-control-expose-headers': 'set-auth-jwt', ...(signedIn ? { 'set-auth-jwt': 'TEST_OWNER_TOKEN' } : {}) };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (pathname.endsWith('/sign-in/email')) signedIn = true;
      if (signedIn) headers['set-auth-jwt'] = 'TEST_OWNER_TOKEN';
      if (pathname.endsWith('/sign-out')) signedIn = false;
      return route.fulfill({ json: pathname.endsWith('/token') ? { token: 'TEST_OWNER_TOKEN' } : pathname.endsWith('/sign-in/email') ? { ...session(), redirect: false, token: 'TEST_SESSION' } : session(), headers });
    });
    await page.route('https://api.test/**', async route => {
      const req = route.request();
      const response = await api(new Request(req.url(), { method: req.method(), headers: await req.allHeaders(), ...(req.postData() ? { body: req.postData() } : {}) }));
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.route('https://journal.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (name === 'neon-public.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.NEON_CONFIG={authUrl:"https://auth.test/auth",apiUrl:"https://api.test"};' });
      assert(!name.includes('..'));
      return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: await fs.readFile(path.join(__dirname, '..', 'dist', name)) });
    });
    await page.goto('https://journal.test/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('#neon-login input[name=email]').fill('owner@example.test');
    await page.locator('#neon-login input[name=password]').fill('TEST_PASSWORD_ONLY');
    await page.locator('#neon-login').getByRole('button', { name: 'Sign in', exact: true }).click();
    try { await page.getByRole('button', { name: 'Set up journal', exact: true }).waitFor({ timeout: 10000 }); }
    catch (error) { console.error('Identity fixture paths:', authPaths, 'Page errors:', errors, 'Status:', await page.locator('#neon-status').textContent()); throw error; }
    await page.getByRole('button', { name: 'Set up journal', exact: true }).click();
    await page.getByLabel('First account name').fill('Neon test account');
    await page.getByRole('button', { name: 'Create journal', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.getByRole('button', { name: 'New trade', exact: true }).click();
    await page.getByLabel('Trade name', { exact: true }).fill('Postgres Call');
    await page.getByLabel('Underlying symbol').fill('TEST');
    await page.getByLabel('Entry date', { exact: true }).fill('2026-11-02');
    await page.getByLabel('Strike (single option)', { exact: true }).fill('100');
    await page.getByLabel('Expiry (package)', { exact: true }).fill('2026-12-18');
    await page.getByLabel('Whole strategy — quantity (0 to skip)', { exact: true }).fill('2');
    await page.getByLabel('Price per share / strategy unit (USD)', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Save trade', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    let saved = await repository.load(owner);
    assert.equal(saved.data.trades.records.length, 1);
    assert.equal(saved.data.actions.records.length, 1);
    assert(saved.data.history.records.length > 0);
    await page.reload();
    await page.getByRole('button', { name: 'Postgres Call', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal((await page.locator('body').textContent()).includes('Postgres Call'), false);
    assert.deepEqual(errors, []);
    console.log('PASS: Neon auth SDK sign-in, journal setup, trade save with real Postgres revisions/audit, reload restoration and sign-out. Identity transport mocked.');
  } finally {
    await browser.close();
    await pool.query('DELETE FROM trading_journal.revisions WHERE owner_id=$1', [owner]);
    await pool.query('DELETE FROM trading_journal.commits WHERE owner_id=$1', [owner]);
    await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
