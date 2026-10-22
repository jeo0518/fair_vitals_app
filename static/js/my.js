// My page: log in, create an account, log out, set your age, and see your pulse log (a chart of your
// daily resting heart rate with your typical range shaded, and a table of each day). Talks to /api/*
// (auth.py, readings.py); the session lives in an HttpOnly cookie, so this script never sees it.
const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const STATUS = { normal: 'Normal', low: 'Low', high: 'High', unknown: 'No range' };
let log = null, span = 30;              // the last /api/readings answer; days shown in the chart (0 = all)

function show(user) {
  $('loading').hidden = true;
  $('signed-out').hidden = !!user;
  $('signed-in').hidden = !user;
  $('log').hidden = !user;
  if (!user) return;
  $('who').textContent = user.name || user.email.split('@')[0];
  $('email').textContent = user.email;
  $('age-text').textContent = user.age == null ? 'no age yet' : `${user.age} years old`;
  $('since').textContent = new Date(user.member_since + 'T00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  $('age-form').hidden = user.age != null;
  $('age-why').hidden = user.age != null;
  $('edit-age').hidden = user.age == null;
  loadLog();
}

function fail(message) {
  $('loading').textContent = message;
  $('loading').hidden = false;
}

async function api(path, body, method) {
  const opts = body === undefined ? { method: method || 'GET' }
    : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  try { return await res.json(); } catch { return { ok: false, message: `The server replied ${res.status} ${res.statusText}.` }; }
}

// ---------------------------------------------------------------- log in / create account / log out
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

function wire(form, send) {
  const error = form.querySelector('.form-error'), button = form.querySelector('button[type=submit]');
  form.onsubmit = async e => {
    e.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      const r = await send(Object.fromEntries(new FormData(form)));
      if (!r.ok) { error.textContent = r.message || 'Something went wrong.'; return; }
      form.reset();
      show(r.user);
    } catch {
      error.textContent = "Couldn't reach the server. Is it running?";
    } finally {
      button.disabled = false;
    }
  };
}
wire($('login-form'), data => api('/api/login', data));
wire($('signup-form'), data => api('/api/signup', data));
wire($('age-form'), data => api('/api/me', data, 'PATCH'));
$('edit-age').onclick = () => { $('age-form').hidden = false; $('age-form').querySelector('input').focus(); };

$('logout').onclick = async () => {
  $('logout').disabled = true;
  try { await api('/api/logout', {}); show(null); pick('tab-login'); }
  finally { $('logout').disabled = false; }
};

// ---------------------------------------------------------------- the pulse log
async function loadLog() {
  const r = await api('/api/readings').catch(() => ({ ok: false }));
  if (!r.ok) { $('log-empty').hidden = false; $('log-empty').textContent = r.message || "Couldn't load your readings."; return; }
  log = r;
  const has = r.readings.length > 0;
  $('log-empty').hidden = has;
  $('log-body').hidden = !has;
  if (!has) return;
  renderStats();
  renderChart();
  renderDays();
  revealIn($('log'));
}

const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDay = (d, year) => d.toLocaleDateString(undefined, year ? { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' } : { month: 'short', day: 'numeric' });
const fmtTime = d => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const statusOf = bpm => !log.range ? 'unknown' : bpm < log.range.low ? 'low' : bpm > log.range.high ? 'high' : 'normal';

/** Readings grouped by the day they were taken (local time), oldest first: {key, date, bpm (average), readings}. */
function days() {
  const map = new Map();
  for (const r of log.readings) {
    const d = new Date(r.measured_at), key = dayKey(d);
    if (!map.has(key)) map.set(key, { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12), readings: [] });
    map.get(key).readings.push({ ...r, time: d });
  }
  return [...map.values()].map(day => ({ ...day, bpm: day.readings.reduce((s, r) => s + r.bpm, 0) / day.readings.length }));
}

function renderStats() {
  const all = days(), last = log.readings[log.readings.length - 1], week = all.slice(-7);
  $('stat-latest').textContent = `${Math.round(last.bpm)} BPM`;
  $('stat-latest-lbl').textContent = `last reading, ${fmtDay(new Date(last.measured_at))}`;
  $('stat-week').textContent = `${Math.round(week.reduce((s, d) => s + d.bpm, 0) / week.length)} BPM`;
  $('stat-days').textContent = all.length;
}

function el(name, attrs, parent, text) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function renderChart() {
  const svg = $('chart'), wrap = $('chart-wrap'), tip = $('tooltip');
  let pts = days();
  if (span) {
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - span + 1);
    pts = pts.filter(p => p.date >= from);
  }
  svg.replaceChildren();
  tip.hidden = true;
  const W = Math.max(wrap.clientWidth, 280), H = W < 500 ? 220 : 280;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!pts.length) {
    el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: 'currentColor' }, svg, `Nothing saved in the last ${span} days.`);
    $('chart-desc').textContent = '';
    return;
  }
  const m = { l: 40, r: 44, t: 16, b: 28 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const values = pts.map(p => p.bpm).concat(log.range ? [log.range.low, log.range.high] : []);
  const step = 20, y0 = Math.floor((Math.min(...values) - 5) / step) * step, y1 = Math.ceil((Math.max(...values) + 5) / step) * step;
  const t0 = pts[0].date.getTime(), t1 = pts[pts.length - 1].date.getTime();
  const x = t => pts.length === 1 ? m.l + iw / 2 : m.l + (t - t0) / (t1 - t0) * iw;
  const y = v => m.t + (1 - (v - y0) / (y1 - y0)) * ih;

  // grid and y axis
  const grid = el('g', { class: 'grid' }, svg), axis = el('g', { class: 'axis' }, svg);
  for (let v = y0; v <= y1; v += step) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, grid);
    el('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, axis, v);
  }
  // typical range band
  if (log.range) {
    el('rect', { class: 'band', x: m.l, width: iw, y: y(log.range.high), height: y(log.range.low) - y(log.range.high) }, svg);
    el('line', { class: 'band-edge', x1: m.l, x2: W - m.r, y1: y(log.range.high), y2: y(log.range.high) }, svg);
    el('line', { class: 'band-edge', x1: m.l, x2: W - m.r, y1: y(log.range.low), y2: y(log.range.low) }, svg);
    el('text', { class: 'band-label', x: m.l + 8, y: y(log.range.high) + 16 }, svg, `Normal range, ${log.range.low} to ${log.range.high}`);
  }
  // x axis: as many evenly spaced dates as fit (about one per 90 px), at most 6
  const n = Math.max(2, Math.min(6, Math.floor(iw / 90)));
  const ticks = pts.length <= n ? pts : Array.from({ length: n }, (_, i) => pts[Math.round(i * (pts.length - 1) / (n - 1))]);
  for (const p of ticks) el('text', { x: x(p.date.getTime()), y: H - 8, 'text-anchor': 'middle' }, axis, fmtDay(p.date));
  // the line, the dots, and the latest value at the end
  if (pts.length > 1) el('path', { class: 'line', d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date.getTime()).toFixed(1)},${y(p.bpm).toFixed(1)}`).join('') }, svg);
  const cross = el('line', { class: 'cross', y1: m.t, y2: H - m.b, visibility: 'hidden' }, svg);
  for (const p of pts) el('circle', { class: `dot${statusOf(p.bpm) === 'normal' ? '' : ' out'}`, cx: x(p.date.getTime()), cy: y(p.bpm), r: 4 }, svg);
  const lastP = pts[pts.length - 1];
  el('text', { class: 'end-label', x: x(lastP.date.getTime()) + 9, y: y(lastP.bpm) + 4 }, svg, Math.round(lastP.bpm));

  // hover: crosshair + tooltip on the nearest day
  const hit = el('rect', { class: 'hit', x: m.l - 10, y: m.t, width: iw + 20, height: ih }, svg);
  hit.onpointermove = e => {
    const box = svg.getBoundingClientRect(), px = (e.clientX - box.left) * W / box.width;
    const p = pts.reduce((a, b) => Math.abs(x(b.date.getTime()) - px) < Math.abs(x(a.date.getTime()) - px) ? b : a);
    const cx = x(p.date.getTime());
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${fmtDay(p.date, true)}</b><br>${Math.round(p.bpm)} BPM`
      + (p.readings.length > 1 ? ` <span class="t-muted">(average of ${p.readings.length})</span>` : '')
      + `<br><span class="t-muted">${{ normal: 'In the normal range', low: 'Below the normal range', high: 'Above the normal range', unknown: '' }[statusOf(p.bpm)]}</span>`;
    tip.hidden = false;
    tip.style.left = `${cx * box.width / W}px`;
    tip.style.top = `${y(p.bpm) * box.height / H}px`;
  };
  hit.onpointerleave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };

  const out = pts.filter(p => statusOf(p.bpm) !== 'normal').length;
  $('chart-desc').textContent = `${fmtDay(pts[0].date, true)} to ${fmtDay(lastP.date, true)}, ${pts.length} day${pts.length > 1 ? 's' : ''}. `
    + (log.range && out ? `Red dots are outside the normal range (${out}). ` : '') + 'Point at a day to see its numbers.';
}

function renderDays() {
  const body = $('days').tBodies[0];
  body.replaceChildren();
  for (const day of days().reverse()) {
    const tr = body.insertRow(), status = statusOf(day.bpm);
    tr.insertCell().textContent = fmtDay(day.date, true);
    const cell = tr.insertCell();
    cell.className = 'num';
    cell.append(`${Math.round(day.bpm)} BPM`);
    const times = document.createElement('div');
    times.className = 'times';
    for (const r of day.readings) {
      const item = document.createElement('div');
      item.append(`${fmtTime(r.time)} · ${Math.round(r.bpm)} BPM`);
      const del = document.createElement('button');
      del.className = 'del'; del.type = 'button'; del.textContent = '×';
      del.title = 'Delete this reading'; del.setAttribute('aria-label', `Delete the ${fmtTime(r.time)} reading`);
      del.onclick = async () => {
        if (!confirm(`Delete ${Math.round(r.bpm)} BPM from ${fmtDay(r.time, true)} at ${fmtTime(r.time)}?`)) return;
        const res = await api(`/api/readings/${r.id}`, undefined, 'DELETE');
        if (res.ok) loadLog(); else alert(res.message || "Couldn't delete that reading.");
      };
      item.append(del);
      times.append(item);
    }
    cell.append(times);
    const chip = document.createElement('span');
    chip.className = `chip small-chip ${status}`;
    chip.textContent = STATUS[status];
    tr.insertCell().append(chip);
  }
}

for (const tab of document.querySelectorAll('.range-tabs .tab')) {
  tab.onclick = () => {
    span = +tab.dataset.days;
    for (const t of document.querySelectorAll('.range-tabs .tab')) t.setAttribute('aria-selected', t === tab);
    renderChart();
  };
}
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (log && log.readings.length) renderChart(); }, 150); });

(async () => {
  try {
    const r = await api('/api/me');
    if (!r.ok) { fail(r.message || "Accounts aren't working right now. Please try again later."); return; }
    show(r.user);
  } catch {
    fail("Couldn't reach the server.");
  }
})();
