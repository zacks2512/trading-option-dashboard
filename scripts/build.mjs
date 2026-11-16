import { build } from 'esbuild';
import { functionBaseUrl } from '@neon/env';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';

// Only this explicit whitelist is published. Never copy .env, .neon or server files.
try { process.loadEnvFile('.env.local'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = process.env.NEON_AUTH_BASE_URL
  ? { authUrl: process.env.NEON_AUTH_BASE_URL, apiUrl: functionBaseUrl('journal') }
  : JSON.parse(await readFile('neon-public-config.json', 'utf8'));
for (const url of Object.values(config)) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid public service URL.');
}
await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
for (const file of ['dashboard-theme.css', 'journal.css', 'journal-engine.js', 'journal-store.js', 'journal-app.js', 'ibkr-import.js', 'ibkr-reconcile.js', 'overview-drill.js', 'vendor/purify.min.js', 'vendor/DOMPurify-LICENSE']) await copyFile(file, `dist/${file}`);
const html = (await readFile('index.html', 'utf8'))
  .replace('<script src="journal-engine.js">', '<script src="neon-public.js"></script>\n<script src="journal-engine.js">')
  .replace(/<script src="private-sheets\.js[^>]*><\/script>/, '<script src="neon-client.js"></script>')
  .replaceAll('Connect Google and choose your private sheet, or load a local file.', 'Sign in to your private journal to view analytics.');
await writeFile('dist/index.html', html);
await writeFile('dist/neon-public.js', `window.NEON_CONFIG=${JSON.stringify(config)};\n`);
await build({ entryPoints: ['client/main.mjs'], bundle: true, format: 'iife', platform: 'browser', target: ['es2022'], outfile: 'dist/neon-client.js', minify: true });
console.log('Built Neon frontend in dist. Only public service URLs are included.');
