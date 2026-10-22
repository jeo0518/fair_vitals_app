// Home page: upload a video to /analyze and show the result.
const $ = id => document.getElementById(id);
$('video').onchange = () => {
  const file = $('video').files[0];
  $('file-name').textContent = file ? file.name : 'No video chosen';
};
$('go').onclick = async () => {
  const file = $('video').files[0];
  if (!file) { $('status').textContent = 'Choose a video first.'; return; }
  $('status').textContent = 'Uploading and analyzing… (can take a while on a CPU server)';
  $('result').innerHTML = '';
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
            + '<span class="verdict ok">Reliable reading</span>';
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
  
