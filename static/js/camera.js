// Home page: record the video right here with the front camera. While the camera is open, a few checks run
// on a small copy of each frame (5 times a second) and tell you what to fix before and while you record:
//   light       is the room bright enough? (judged on the whole picture, not on the face: a face check
//               would call darker skin "too dark" even in good light)
//   background  is there a bright light behind you? (a lamp or window behind you leaves the face in shadow,
//               the hardest case in our tests)
//   steady      are you and the phone holding still?
//   face        is a face in the oval? (only where the browser can detect faces; otherwise a reminder)
// The checks advise, they never block recording. The recording becomes the video that Analyze sends.
(() => {
  const $ = id => document.getElementById(id);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return;   // old browser: just upload
  $('cam-open').hidden = false;

  const MIN_SEC = 20, MAX_SEC = 30;
  const video = $('cam-video'), card = document.querySelector('.instruction');
  const small = document.createElement('canvas'), sctx = small.getContext('2d', { willReadFrequently: true });
  const SW = 96, SH = 72;                                       // checks run on a 96 x 72 copy: cheap and enough
  small.width = SW; small.height = SH;
  const faceDetector = 'FaceDetector' in window ? new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 }) : null;
  let stream = null, timer = null, recorder = null, chunks = [], recStart = 0, prev = null, shake = 0;

  // ---------------------------------------------------------------- the checks
  const CHECKS = {
    light: { el: 'chk-light', ok: 'Light is good', bad: 'Too dark: find brighter light' },
    back: { el: 'chk-back', ok: 'No bright light behind you', bad: 'Bright light behind you: face the light instead' },
    still: { el: 'chk-still', ok: 'Holding still', bad: 'Moving: hold still and steady the phone' },
    face: { el: 'chk-face', ok: 'Face in the oval', bad: 'Move your face into the oval', unknown: 'Keep your face inside the oval' },
  };
  function show(name, state) {                                   // state: true (ok), false (fix this), null (can't tell)
    const c = CHECKS[name], el = $(c.el);
    el.className = state === true ? 'ok' : state === false ? 'bad' : 'info';
    el.textContent = state === true ? c.ok : state === false ? c.bad : c.unknown;
  }

  const inOval = (x, y) => ((x - SW / 2) / (SW * 0.2)) ** 2 + ((y - SH * 0.47) / (SH * 0.36)) ** 2 <= 1;
  const inFace = (x, y) => ((x - SW / 2) / (SW * 0.1)) ** 2 + ((y - SH * 0.45) / (SH * 0.18)) ** 2 <= 1;
  const OVAL = [], FACE = [], EDGE = [];                         // pixel indexes: the oval, its middle (the face), the border
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    if (inOval(x, y)) OVAL.push(y * SW + x);
    if (inFace(x, y)) FACE.push(y * SW + x);
    if (x < SW * 0.18 || x > SW * 0.82 || y < SH * 0.15) EDGE.push(y * SW + x);
  }

  async function check() {
    if (!video.videoWidth) return;
    sctx.drawImage(video, 0, 0, SW, SH);
    const px = sctx.getImageData(0, 0, SW, SH).data, lum = new Float32Array(SW * SH);
    let all = 0;
    for (let i = 0; i < SW * SH; i++) { lum[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2]; all += lum[i]; }
    all /= SW * SH;
    const mean = idx => idx.reduce((s, i) => s + lum[i], 0) / idx.length;
    const face = mean(FACE), edge = mean(EDGE);
    const glare = EDGE.filter(i => lum[i] > 220).length / EDGE.length;   // share of the border that's near white

    show('light', all >= 60);                                     // the whole picture: is the room lit?
    show('back', !(glare > 0.4 && edge > face * 1.3));            // a window or lamp behind you, brighter than your face
    if (prev) {                                                    // how much the oval changed since the last check (smoothed)
      let d = 0;
      for (const i of OVAL) d += Math.abs(lum[i] - prev[i]);
      shake = 0.6 * shake + 0.4 * d / OVAL.length / Math.max(mean(OVAL), 20);
      show('still', shake < 0.05);
    }
    prev = lum;
    if (faceDetector) {
      try {
        const [f] = await faceDetector.detect(video);
        if (!f) return show('face', false);
        const b = f.boundingBox, cx = (b.x + b.width / 2) / video.videoWidth, cy = (b.y + b.height / 2) / video.videoHeight;
        show('face', Math.abs(cx - 0.5) < 0.15 && Math.abs(cy - 0.47) < 0.2 && b.width / video.videoWidth > 0.15);
      } catch { show('face', null); }
    } else {
      show('face', null);
    }
  }

  // ---------------------------------------------------------------- camera on / off
  async function open() {
    $('cam-open').disabled = true;
    $('status').textContent = 'Asking for the camera…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
    } catch (e) {
      $('status').textContent = e.name === 'NotAllowedError'
        ? "We can't use the camera because permission was denied. You can allow it in your browser's settings, or choose a video instead."
        : "We couldn't start the camera. You can choose a video instead.";
      $('cam-open').disabled = false;
      return;
    }
    $('status').textContent = '';
    video.srcObject = stream;
    $('cam').hidden = false;
    card.classList.add('hold-still');
    prev = null; shake = 0;
    for (const name in CHECKS) show(name, null);
    timer = setInterval(check, 200);
    $('cam').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function close() {
    clearInterval(timer); timer = null;
    if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
    recorder = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
    $('cam').hidden = true;
    $('cam').classList.remove('recording');
    $('cam-count').textContent = '';
    $('cam-rec').textContent = 'Start recording';
    $('cam-rec').disabled = false;
    $('cam-open').disabled = false;
    card.classList.remove('hold-still');
  }

  // ---------------------------------------------------------------- recording
  const TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

  function start() {
    const type = TYPES.find(t => MediaRecorder.isTypeSupported(t)) || '';
    // a high bitrate keeps the tiny color changes of the pulse that heavy compression would smooth away
    recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6e6 });
    chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = finish;
    recorder.start(1000);
    recStart = Date.now();
    $('cam').classList.add('recording');
    $('cam-rec').textContent = 'Stop';
    $('cam-rec').disabled = true;                                 // you can stop once there's enough video
    tick();
  }

  function tick() {
    if (!recorder || recorder.state !== 'recording') return;
    const s = (Date.now() - recStart) / 1000;
    $('cam-count').textContent = `${Math.floor(s)} s`;
    $('cam-rec').disabled = s < MIN_SEC;
    $('cam-rec').textContent = s < MIN_SEC ? `Keep going… ${Math.ceil(MIN_SEC - s)} s` : 'Stop';
    if (s >= MAX_SEC) { recorder.stop(); return; }
    setTimeout(tick, 250);
  }

  function finish() {
    const secs = Math.round((Date.now() - recStart) / 1000), type = recorder.mimeType || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const file = new File(chunks, `recording.${ext}`, { type });
    close();
    window.useRecording(file, `Your recording (${secs} s, ${(file.size / 2 ** 20).toFixed(0)} MB)`);
    $('status').textContent = 'Recorded. Press Analyze to get your heart rate.';
    $('go').focus();
  }

  $('cam-open').onclick = open;
  $('cam-close').onclick = () => { close(); $('status').textContent = ''; };
  $('cam-rec').onclick = () => (recorder ? recorder.stop() : start());
  addEventListener('pagehide', close);
})();
