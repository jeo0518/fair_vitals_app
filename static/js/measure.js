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
  if (!file) { $('status').textContent = 'Choose a video first.'; return; }
  $('status').textContent = 'Uploading and analyzing… (can take a while on a CPU server)';
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
    if (!r.ok && !r.readings) { $('result').innerHTML = `<p>${r.message || 'Something went wrong.'}</p>`; return; }
    const trust = Math.round(r.trust_score * 100), threshold = Math.round(r.threshold * 100);
    let html = '';
    if (r.heart_rate_bpm !== null) {
      html += `<h2 class="hr">${r.heart_rate_bpm} <small>BPM</small></h2>`
            + '<span class="verdict ok">Reliable reading</span>'
            + '<div class="save-row"><button id="save" class="btn btn-primary">Save the pulse rate</button>'
            + '<span id="save-msg" class="muted" role="status"></span></div>';
      lastResult = r;
    } else {
      html += '<h2 class="hr">No reliable reading</h2>'
            + `<span class="verdict bad">Please retake</span><p>${r.message || ''}</p>`;
    }
    html += `<p><b>Trust score:</b> ${trust}%</p>`
          + `<div class="meter"><div class="meter-fill" style="width:${trust}%"></div>`
          + `<div class="meter-mark" style="left:${threshold}%" title="threshold ${threshold}%"></div></div>`
          + `<p class="muted">${r.readings_reliable} of ${r.readings_total} ten-second readings passed `
          + `the ${threshold}% threshold (black mark).</p>`;
    if (r.tips.length) html += '<ul class="tips">' + r.tips.map(t => `<li>${t}</li>`).join('') + '</ul>';
    html += '<details><summary>Per-reading details</summary><div class="details-body"><div class="table-wrap"><table><tr><th>start (s)</th><th>heart rate</th>'
          + '<th>trust</th><th>accepted</th><th>CNN</th><th>POS</th><th>flicker</th></tr>'
          + r.readings.map(w => `<tr><td>${w.start_s}</td><td>${w.hr_bpm}</td><td>${(w.p_reliable * 100).toFixed(0)}%</td>`
            + `<td>${w.reliable ? 'yes' : 'no'}</td><td>${w.hr_cnn}</td><td>${w.hr_pos}</td><td>${w.flicker ? 'yes' : ''}</td></tr>`).join('')
          + '</table></div>'
          + `<p class="muted">Reading from: ${r.details.estimate}. CNN: ${r.details.cnn}. `
          + `Face detector: ${r.details.face_detector}. Video length analyzed: ${r.duration_s} s.</p></div></details>`;
    $('result').innerHTML = html;
    revealIn($('result'));
  } catch (e) {
    $('status').textContent = 'Request failed: ' + e.message;
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
      msg.innerHTML = 'Log in or create an account on <a class="link-arrow" href="/my">My page</a> to save your readings.';
      button.disabled = false;
      return;
    }
  } catch {
    r = { ok: false, message: 'Could not reach the server.' };
  }
  if (!r.ok) { msg.textContent = r.message || 'Could not save this reading.'; button.disabled = false; return; }
  msg.textContent = '';
  button.textContent = 'Saved ✓';
  showVerdict(r.reading, r.assessment);
  showAdvice(r.assessment);
  turnTo(1);
});

const LABELS = { normal: 'Within the typical range', low: 'Lower than typical', high: 'Higher than typical',
                 unknown: 'No range for this age' };

function showVerdict(reading, a) {
  const bpm = Math.round(reading.bpm);
  let html = '<p class="eyebrow">Saved to your daily log</p>'
           + '<div class="verdict-head">'
           + `<h2 class="verdict-bpm">${bpm} <small>BPM</small></h2>`
           + `<span class="chip ${a.status}${a.far ? ' far' : ''}">${LABELS[a.status]}</span></div>`;
  if (a.status === 'unknown') {
    html += '<p>We don\'t have a checked resting range for this age, so this reading is saved without a comparison.</p>';
  } else {
    // scale from 30 to 150 BPM (wider if the reading is outside), typical range shaded, marker at the reading
    const lo = Math.min(30, bpm - 10), hi = Math.max(150, bpm + 10), at = v => `${((v - lo) / (hi - lo) * 100).toFixed(2)}%`;
    html += `<div class="scale" role="img" aria-label="${bpm} BPM on a scale where the typical range is ${a.low} to ${a.high} BPM">`
          + `<div class="scale-band" style="left:${at(a.low)};width:calc(${at(a.high)} - ${at(a.low)})"></div>`
          + `<div class="scale-mark" style="left:${at(bpm)}"></div>`
          + `<span class="scale-tick reading" style="left:${at(bpm)}">${bpm}</span>`
          + `<span class="scale-tick" style="left:${at(a.low)}">${a.low}</span>`
          + `<span class="scale-tick" style="left:${at(a.high)}">${a.high}</span></div>`
          + `<p>The typical resting heart rate for ${a.who} is <b>${a.low}–${a.high} BPM</b>`
          + (a.age == null ? '.' : `, and you're ${a.age}.`) + '</p>';
    if (a.age == null) {
      html += '<p class="note">Add your age on <a class="link-arrow" href="/my">My page</a> so readings are compared with the range for your age. Until then, the adult range is used.</p>';
    }
    if (a.near_edge) {
      html += '<p class="muted">This reading is within 5 BPM of the edge of the range, which is about how far off a camera reading can be. Measuring again will tell you more.</p>';
    }
  }
  html += '<div class="card-actions">'
        + (a.status === 'unknown' ? '' : '<button class="btn btn-primary" id="to-advice">What can I do? →</button>')
        + '<button class="btn" id="again">← Measure again</button>'
        + '<a class="btn" href="/my">See my log</a></div>';
  $('verdict-card').querySelectorAll(':scope > :not(.card-fx)').forEach(el => el.remove());
  $('verdict-card').insertAdjacentHTML('beforeend', html);
  $('again').onclick = () => turnTo(0);
  if ($('to-advice')) $('to-advice').onclick = () => turnTo(2);
}

const ADVICE = {
  normal: {
    title: 'Keeping your readings comparable',
    items: [
      'Measure at about the same time each day, seated, after resting for at least 10 minutes. That makes day-to-day changes in your log meaningful.',
      'Regular activity, enough sleep and enough water all help keep a resting heart rate steady.',
      'Caffeine, stress, a big meal or having just moved can raise it for a while. If one day looks unusual, measure again later.',
    ],
  },
  high: {
    title: 'If your heart rate is higher than typical',
    items: [
      '<b>Rest, then measure again.</b> Sit quietly for at least 10 minutes first. Walking, climbing stairs, talking or feeling rushed all raise it for a while.',
      '<b>Breathe slowly</b> for a few minutes, for example in for 4 seconds and out for 6.',
      '<b>Drink some water.</b> Being dehydrated raises your heart rate.',
      '<b>Cut back on stimulants:</b> coffee, energy drinks, nicotine and alcohol can all speed it up.',
      'Fever or illness, stress or anxiety and poor sleep can also raise it.',
      'If it stays above the range at rest on several days, talk to a doctor.',
    ],
  },
  low: {
    title: 'If your heart rate is lower than typical',
    items: [
      '<b>This can be normal.</b> Well-trained athletes and very active people often have a resting heart rate of 40–60 BPM.',
      '<b>Measure again</b> in good, even light while holding still: a camera reading can be a few BPM off.',
      '<b>Check your medicines.</b> Some, such as beta blockers, slow the heart. Your doctor or pharmacist can tell you.',
      'If it stays below the range and you feel tired, dizzy, faint or short of breath, talk to a doctor.',
    ],
  },
};

function showAdvice(a) {
  const card = $('advice-card');
  card.querySelectorAll(':scope > :not(.card-fx)').forEach(el => el.remove());
  if (a.status === 'unknown') return;
  const tip = ADVICE[a.status];
  let html = `<p class="eyebrow">What you can do</p><h2>${tip.title}</h2>`
           + '<ul class="plain">' + tip.items.map(t => `<li>${t}</li>`).join('') + '</ul>';
  if (a.status !== 'normal') {
    html += '<p class="note urgent"><b>Get medical help right away</b> (call your local emergency number) if a fast or slow '
          + 'heart rate comes with chest pain, fainting, severe shortness of breath or confusion.'
          + (a.far ? ' A reading this far outside the range is also worth getting checked soon if measuring again gives the same.' : '')
          + '</p>';
  }
  html += '<p class="muted">General information, not medical advice. Ranges from MedlinePlus (U.S. National Library of Medicine).</p>'
        + '<div class="card-actions"><button class="btn" id="to-verdict">← Back to my result</button>'
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
