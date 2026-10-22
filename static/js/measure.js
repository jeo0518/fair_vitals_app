// Home page: upload a video to /analyze, show the result, and save it to the daily log (turning the
// upload card over like a book page to the verdict beneath it).
const $ = id => document.getElementById(id);
const stillMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let lastResult = null;
$('video').onchange = () => {
  const file = $('video').files[0];
  $('file-name').textContent = file ? file.name : 'No video chosen';
};
$('go').onclick = async () => {
  const file = $('video').files[0];
  if (!file) { $('status').textContent = 'Pick a video first.'; return; }
  $('status').textContent = 'Uploading and analysing. This can take a minute…';
  $('result').innerHTML = '';
  lastResult = null;
  $('go').disabled = true;
  const form = new FormData(); form.append('video', file);
  try {
    const res = await fetch('/analyze', { method: 'POST', body: form });
    const text = await res.text();
    let r;
    try { r = JSON.parse(text); } catch { throw new Error(`server replied ${res.status} ${res.statusText}`); }
    $('status').textContent = '';
    if (!r.ok && !r.readings) { $('result').innerHTML = `<p>${r.message || 'Something went wrong. Please try again.'}</p>`; return; }
    const trust = Math.round(r.trust_score * 100), threshold = Math.round(r.threshold * 100);
    let html = '';
    if (r.heart_rate_bpm !== null) {
      html += `<h2 class="hr">${r.heart_rate_bpm} <small>BPM</small></h2>`
            + '<span class="verdict ok">We trust this one</span>'
            + '<div class="save-row"><button id="save" class="btn btn-primary">Save the pulse rate</button>'
            + '<span id="save-msg" class="muted" role="status"></span></div>';
      lastResult = r;
    } else {
      html += '<h2 class="hr">No reading this time</h2>'
            + `<span class="verdict bad">Try another video</span><p>${r.message || ''}</p>`;
    }
    html += `<p><b>Trust score:</b> ${trust}%</p>`
          + `<div class="meter"><div class="meter-fill" style="width:${trust}%"></div>`
          + `<div class="meter-mark" style="left:${threshold}%" title="threshold ${threshold}%"></div></div>`
          + `<p class="muted">${r.readings_reliable} of ${r.readings_total} ten-second pieces scored above `
          + `${threshold}% (the black line).</p>`;
    if (r.tips.length) html += '<ul class="tips">' + r.tips.map(t => `<li>${t}</li>`).join('') + '</ul>';
    html += '<details><summary>Details for each 10 seconds</summary><div class="details-body"><div class="table-wrap"><table><tr><th>from (s)</th><th>heart rate</th>'
          + '<th>trust</th><th>used</th><th>CNN</th><th>POS</th><th>flicker</th></tr>'
          + r.readings.map(w => `<tr><td>${w.start_s}</td><td>${w.hr_bpm}</td><td>${(w.p_reliable * 100).toFixed(0)}%</td>`
            + `<td>${w.reliable ? 'yes' : 'no'}</td><td>${w.hr_cnn}</td><td>${w.hr_pos}</td><td>${w.flicker ? 'yes' : ''}</td></tr>`).join('')
          + '</table></div>'
          + `<p class="muted">Method: ${r.details.estimate}. Models: ${r.details.cnn}. `
          + `Face detector: ${r.details.face_detector}. Seconds of video used: ${r.duration_s}.</p></div></details>`;
    $('result').innerHTML = html;
    revealIn($('result'));
  } catch (e) {
    $('status').textContent = "That didn't work (" + e.message + '). Please try again.';
  } finally {
    $('go').disabled = false;
  }
};

// Per-reading details: slide the table open and closed instead of jumping.
$('result').addEventListener('click', e => {
  const summary = e.target.closest('summary');
  if (!summary || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const details = summary.parentElement, body = details.querySelector('.details-body');
  e.preventDefault();
  body.getAnimations().forEach(a => a.cancel());
  const opening = !details.open || details.classList.contains('closing');
  details.classList.remove('closing');
  details.open = true;
  const h = body.scrollHeight;
  const anim = body.animate(
    opening ? [{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 1 }]
            : [{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
    { duration: 350, easing: 'ease' });
  if (!opening) {
    details.classList.add('closing');
    anim.onfinish = () => { details.open = false; details.classList.remove('closing'); };
  }
});

// ---------------------------------------------------------------- saving to the daily log
$('result').addEventListener('click', async e => {
  if (e.target.id !== 'save' || !lastResult) return;
  const button = e.target, msg = $('save-msg');
  button.disabled = true;
  msg.textContent = 'Saving…';
  let r;
  try {
    const res = await fetch('/api/readings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bpm: lastResult.heart_rate_bpm, trust: lastResult.trust_score }) });
    r = await res.json().catch(() => ({ ok: false, message: `The server replied ${res.status}.` }));
    if (res.status === 401) {
      msg.innerHTML = 'You need an account to save readings. <a class="link-arrow" href="/my">Log in or sign up</a>';
      button.disabled = false;
      return;
    }
  } catch {
    r = { ok: false, message: "Couldn't reach the server." };
  }
  if (!r.ok) { msg.textContent = r.message || "Couldn't save this one. Please try again."; button.disabled = false; return; }
  msg.textContent = '';
  button.textContent = 'Saved';
  showVerdict(r.reading, r.assessment);
  showAdvice(r.assessment);
  turnTo(1);
});

const LABELS = { normal: 'In the usual range', low: 'Lower than usual', high: 'Higher than usual',
                 unknown: 'No range for this age' };

function showVerdict(reading, a) {
  const bpm = Math.round(reading.bpm);
  let html = '<p class="eyebrow">Saved to your log</p>'
           + '<div class="verdict-head">'
           + `<h2 class="verdict-bpm">${bpm} <small>BPM</small></h2>`
           + `<span class="chip ${a.status}${a.far ? ' far' : ''}">${LABELS[a.status]}</span></div>`;
  if (a.status === 'unknown') {
    html += "<p>We don't have a reliable range for this age, so we saved the reading without comparing it.</p>";
  } else {
    // scale from 30 to 150 BPM (wider if the reading is outside), typical range shaded, marker at the reading
    const lo = Math.min(30, bpm - 10), hi = Math.max(150, bpm + 10), at = v => `${((v - lo) / (hi - lo) * 100).toFixed(2)}%`;
    html += `<div class="scale" role="img" aria-label="${bpm} BPM on a scale where the usual range is ${a.low} to ${a.high} BPM">`
          + `<div class="scale-band" style="left:${at(a.low)};width:calc(${at(a.high)} - ${at(a.low)})"></div>`
          + `<div class="scale-mark" style="left:${at(bpm)}"></div>`
          + `<span class="scale-tick reading" style="left:${at(bpm)}">${bpm}</span>`
          + `<span class="scale-tick" style="left:${at(a.low)}">${a.low}</span>`
          + `<span class="scale-tick" style="left:${at(a.high)}">${a.high}</span></div>`
          + `<p>A normal resting heart rate for ${a.who} is ${a.low} to ${a.high} BPM`
          + (a.age == null ? '.' : ` (you're ${a.age}).`) + '</p>';
    if (a.age == null) {
      html += '<p class="note">We don\'t know your age yet, so we used the adult range. You can add it on <a class="link-arrow" href="/my">My page</a>.</p>';
    }
    if (a.near_edge) {
      html += '<p class="muted">This is close to the edge of the range, and a camera reading can be off by a few beats. It\'s worth measuring once more.</p>';
    }
  }
  html += '<div class="card-actions">'
        + (a.status === 'unknown' ? '' : '<button class="btn btn-primary" id="to-advice">What can I do?</button>')
        + '<button class="btn" id="again">Measure again</button>'
        + '<a class="btn" href="/my">See my log</a></div>';
  $('verdict-card').querySelectorAll(':scope > :not(.card-fx)').forEach(el => el.remove());
  $('verdict-card').insertAdjacentHTML('beforeend', html);
  $('again').onclick = () => turnTo(0);
  if ($('to-advice')) $('to-advice').onclick = () => turnTo(2);
}

const ADVICE = {
  normal: {
    title: 'Looks good',
    items: [
      'If you want your log to be useful, try to measure at about the same time every day, sitting down, after resting for 10 minutes or so.',
      'Being active, sleeping well and drinking enough water all help keep your resting heart rate steady.',
      'Coffee, stress, a big meal or having just walked around can push it up for a while, so one odd day is nothing to worry about.',
    ],
  },
  high: {
    title: 'Your heart rate was on the high side',
    items: [
      'First, sit down and rest for about 10 minutes, then measure again. Walking, stairs, talking or being in a rush can all raise it for a while.',
      'Slow breathing helps some people. Try breathing in for 4 seconds and out for 6, for a few minutes.',
      'Have a glass of water. Being dehydrated makes your heart beat faster.',
      'Coffee, energy drinks, nicotine and alcohol can speed it up too.',
      'So can a fever, being sick, stress or a bad night\'s sleep.',
      'If it keeps coming out high while you\'re resting, several days in a row, it\'s worth talking to a doctor.',
    ],
  },
  low: {
    title: 'Your heart rate was on the low side',
    items: [
      'This can be completely normal. People who exercise a lot often have a resting heart rate between 40 and 60.',
      'Try measuring again in good light while keeping still. A camera reading can be a few beats off.',
      'Some medicines slow the heart, beta blockers for example. If you take any, a doctor or pharmacist can tell you whether that\'s why.',
      'If it stays low and you also feel tired, dizzy, faint or short of breath, see a doctor.',
    ],
  },
};

function showAdvice(a) {
  const card = $('advice-card');
  card.querySelectorAll(':scope > :not(.card-fx)').forEach(el => el.remove());
  if (a.status === 'unknown') return;
  const tip = ADVICE[a.status];
  let html = `<h2>${tip.title}</h2>`
           + '<ul class="plain">' + tip.items.map(t => `<li>${t}</li>`).join('') + '</ul>';
  if (a.status !== 'normal') {
    html += '<p class="note urgent"><b>Call your local emergency number</b> if a fast or slow heartbeat comes with chest pain, '
          + 'fainting, bad shortness of breath or confusion.'
          + (a.far ? ' And since this reading is quite far from the usual range, get it checked soon if you measure again and get the same.' : '')
          + '</p>';
  }
  html += '<p class="muted">This is general information, not medical advice. The ranges come from MedlinePlus.</p>'
        + '<div class="card-actions"><button class="btn" id="to-verdict">Back to my result</button>'
        + '<button class="btn" id="again-2">Measure again</button></div>';
  card.insertAdjacentHTML('beforeend', html);
  $('to-verdict').onclick = () => turnTo(1);
  $('again-2').onclick = () => turnTo(0);
}

// ---------------------------------------------------------------- the book: turning pages
// Pages top to bottom: 0 the upload card, 1 the verdict, 2 the advice. `facing` is the page facing up; the
// ones above it have been turned over (hidden), the ones below peek out by their depth (CSS --d).
const PAGES = ['page-front', 'page-back', 'page-advice'].map(id => $(id));
let facing = 0;
const TURN = [{ transform: 'rotateY(0deg)', opacity: 1 }, { transform: 'rotateY(-90deg)', opacity: 1, offset: 0.5 },
              { transform: 'rotateY(-90deg)', opacity: 0, offset: 0.5001 }, { transform: 'rotateY(-180deg)', opacity: 0 }];
const UNTURN = [{ transform: 'rotateY(-180deg)', opacity: 0 }, { transform: 'rotateY(-90deg)', opacity: 0, offset: 0.4999 },
                { transform: 'rotateY(-90deg)', opacity: 1, offset: 0.5 }, { transform: 'rotateY(0deg)', opacity: 1 }];

function stack() {
  PAGES.forEach((page, i) => {
    const d = i - facing;
    if (d >= 0) page.hidden = false;
    page.style.setProperty('--d', Math.max(d, 0));
    page.style.zIndex = 10 - i;                   // pages higher in the book always cover the ones below
    page.classList.toggle('under', d > 0);
  });
}
stack();

// Turn pages over (forward) or back until page `to` faces up. Only the page that actually swings is
// animated: going forward it is the page facing up now; going back, the page coming back on top.
function turnTo(to) {
  if (to === facing) return;
  const forward = to > facing, page = PAGES[forward ? facing : to];
  PAGES.forEach(p => p.getAnimations().forEach(a => a.cancel()));
  const passed = forward ? PAGES.slice(facing, to) : [];
  facing = to;
  stack();
  const done = () => {
    passed.forEach(p => { p.hidden = true; });
    const card = PAGES[facing].querySelector('.card');
    revealIn(card);
    (card.querySelector('.card-actions .btn') || card).focus({ preventScroll: true });
  };
  if (forward) passed.forEach(p => { p.hidden = false; });          // stay visible while turning
  $('book').scrollIntoView({ behavior: stillMotion ? 'auto' : 'smooth', block: 'start' });
  if (stillMotion) { done(); return; }
  // rotate around the left edge like a book page; hidden once edge-on, so its back never shows
  page.animate(forward ? TURN : UNTURN, { duration: 1000, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' }).onfinish = done;
}
