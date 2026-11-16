import { createAuthClient } from '@neon/auth';
import { createNeonStore } from './store.mjs';

const config = window.NEON_CONFIG;
const auth = createAuthClient(config.authUrl);
const $ = id => document.getElementById(id);
let generation = 0;
function status(message) {
  const element = $('neon-status') || $('loadStatus');
  element.style.display = ''; element.textContent = message;
}
async function request(path, body) {
  const { data, error } = await auth.token();
  // @neon/auth 0.8.x may answer /token from its session cache. That cache
  // contains the server's set-auth-jwt value under session.token.
  const token = data?.token || data?.session?.token;
  if (error || !token) {
    generation++; JournalApp.clear(); toolbar(false);
    throw new Error('Sign in again to continue.');
  }
  let response;
  try {
    response = await fetch(config.apiUrl + path, {
      method: body ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    const error = new Error(body ? 'Save response lost. Reload to verify the save.' : 'Cannot reach your journal.');
    error.uncertain = Boolean(body); throw error;
  }
  let result;
  try { result = await response.json(); }
  catch { const error = new Error('Invalid service response. Reload before continuing.'); error.uncertain = Boolean(body); throw error; }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) { generation++; JournalApp.clear(); toolbar(false); }
    const error = new Error(result.error || 'Journal request failed.');
    error.uncertain = Boolean(body) && response.status >= 500; throw error;
  }
  return result;
}
const Store = createNeonStore(window.JournalStore.Store, request);
function toolbar(connected) {
  $('connection-state').textContent = connected ? 'Connected to Neon' : 'Signed out';
  $('connection-state').dataset.state = connected ? 'connected' : 'disconnected';
  $('google-refresh').disabled = !connected; $('google-disconnect').disabled = !connected;
}
async function connect() {
  const current = ++generation;
  const store = new Store();
  // Verify owner authorization before displaying a connected state.
  await store.load();
  if (current !== generation) return;
  await JournalApp.connect({ createStore: () => store });
  if (current === generation) { toolbar(true); status('Your private Neon journal is ready.'); }
}
function signIn() {
  if (document.querySelector('#neon-login')) return;
  const dialog = document.createElement('dialog'); dialog.id = 'neon-login';
  dialog.className = 'journal-dialog';
  // This template is constant; user input is never inserted as HTML.
  dialog.innerHTML = `<h2>Sign in to your private journal</h2>
    <form class="journal-fields">
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label>
      <p id="neon-status" role="status" aria-live="polite"></p>
      <footer><button class="btn p" type="submit">Sign in</button>
      <button class="btn" type="button" data-action="signup">Create account</button>
      <button class="btn" type="button" data-action="verify">Verify email</button>
      <button class="btn" type="button" data-action="cancel">Cancel</button></footer>
    </form>`;
  const form = dialog.querySelector('form');
  async function action(kind) {
    if (!form.reportValidity()) return;
    const email = form.elements.email.value.trim(), password = form.elements.password.value;
    const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
    try {
      if (kind === 'verify') {
        const sent = await auth.emailOtp.sendVerificationOtp({ email, type: 'email-verification' });
        if (sent.error) throw new Error(sent.error.message);
        status('Check your email for a verification code.');
        const code = document.createElement('input'); code.autocomplete = 'one-time-code'; code.placeholder = 'Email verification code'; code.setAttribute('aria-label', 'Email verification code');
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'btn'; confirm.textContent = 'Confirm code';
        form.querySelector('[data-verification]')?.remove();
        const area = document.createElement('div'); area.dataset.verification = ''; area.append(code, confirm); form.append(area);
        confirm.onclick = async () => {
          confirm.disabled = true;
          try { const result = await auth.emailOtp.verifyEmail({ email, otp: code.value.trim() }); if (result.error) throw new Error(result.error.message); status('Email verified. Sign in to continue.'); area.remove(); }
          catch (error) { status(error.message); } finally { confirm.disabled = false; }
        };
        return;
      }
      const result = kind === 'signup' ? await auth.signUp.email({ email, password, name: 'Journal owner' }) : await auth.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message);
      if (kind === 'signup') { status('Account created. Verify your email, then sign in.'); return; }
      await connect(); dialog.close();
    } catch (error) { status(error.message); }
    finally { buttons.forEach(b => b.disabled = false); }
  }
  form.onsubmit = event => { event.preventDefault(); action('signin'); };
  form.querySelector('[data-action="signup"]').onclick = () => action('signup');
  form.querySelector('[data-action="verify"]').onclick = () => action('verify');
  form.querySelector('[data-action="cancel"]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
}
window.NeonJournal = { signIn };
$('google-refresh').onclick = () => connect().catch(error => status(error.message));
$('google-disconnect').onclick = async () => {
  generation++; JournalApp.clear(); toolbar(false); status('Signed out.');
  try { const result = await auth.signOut(); if (result.error) throw new Error(result.error.message); }
  catch { status('The journal is cleared. Server sign-out failed; close this browser session or retry sign-out.'); $('google-disconnect').disabled = false; }
};
const panel = document.querySelector('.connection-panel');
panel.replaceChildren();
const login = document.createElement('button'); login.className = 'btn p'; login.textContent = 'Sign in to Neon'; login.onclick = signIn; panel.append(login);
document.querySelector('.nav-footnote').textContent = 'Private Neon journal';
document.querySelector('.tab[data-page="settings"]').hidden = true;
toolbar(false); JournalApp.render();
const restoreGeneration = generation;
auth.getSession().then(async ({ data, error }) => {
  if (restoreGeneration !== generation) return;
  if (error) throw new Error(error.message);
  if (data?.user) await connect();
}).catch(error => status(error.message));
