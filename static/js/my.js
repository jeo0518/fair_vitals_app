// My page: log in, create an account, log out. Talks to /api/* (auth.py); the session lives in an
// HttpOnly cookie, so this script never sees it.
const $ = id => document.getElementById(id);

function show(user) {
  $('loading').hidden = true;
  $('signed-out').hidden = !!user;
  $('signed-in').hidden = !user;
  if (user) {
    $('who').textContent = user.name || user.email.split('@')[0];
    $('email').textContent = user.email;
    $('since').textContent = new Date(user.member_since + 'T00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }
}

function fail(message) {
  $('loading').hidden = true;
  $('loading').textContent = message;
  $('loading').hidden = false;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let r;
  try { r = await res.json(); } catch { r = { ok: false, message: `The server replied ${res.status} ${res.statusText}.` }; }
  return r;
}

// Tabs: Log in / Create account
function pick(which) {
  for (const [tab, form] of [['tab-login', 'login-form'], ['tab-signup', 'signup-form']]) {
    const on = tab === which;
    $(tab).setAttribute('aria-selected', on);
    $(form).hidden = !on;
  }
  const form = which === 'tab-login' ? $('login-form') : $('signup-form');
  form.querySelector('.form-error').textContent = '';
  form.querySelector('input').focus();
}
$('tab-login').onclick = () => pick('tab-login');
$('tab-signup').onclick = () => pick('tab-signup');

for (const [formId, path] of [['login-form', '/api/login'], ['signup-form', '/api/signup']]) {
  const form = $(formId), error = form.querySelector('.form-error'), button = form.querySelector('button[type=submit]');
  form.onsubmit = async e => {
    e.preventDefault();
    error.textContent = '';
    const data = Object.fromEntries(new FormData(form));
    button.disabled = true;
    try {
      const r = await api(path, data);
      if (!r.ok) { error.textContent = r.message || 'Something went wrong.'; return; }
      form.reset();
      show(r.user);
    } catch (err) {
      error.textContent = 'Could not reach the server. Is it running?';
    } finally {
      button.disabled = false;
    }
  };
}

$('logout').onclick = async () => {
  $('logout').disabled = true;
  try { await api('/api/logout', {}); show(null); pick('tab-login'); }
  finally { $('logout').disabled = false; }
};

(async () => {
  try {
    const r = await api('/api/me');
    if (!r.ok) { fail(r.message || 'Accounts are not available right now.'); return; }
    show(r.user);
  } catch {
    fail('Could not reach the server.');
  }
})();
