// First-visit intro: a first-person flight through space. The ship accelerates to warp speed, stops
// dead, and a heart-shaped planet beats in front of you; then the site fades in. Drawn live on a canvas
// (no video file). The small script in each page's <head> adds html.intro-on for first-time visitors (or
// when the address has ?intro), which hides the page until this finishes. Skip button and Esc skip it;
// with reduced motion it never plays.
(() => {
  const root = document.documentElement, KEY = 'fv-intro-seen';
  if (!root.classList.contains('intro-on')) return;
  const remember = () => { try { localStorage.setItem(KEY, '1'); } catch { /* private mode: it may play again */ } };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { remember(); root.classList.remove('intro-on'); return; }

  // ---------------------------------------------------------------- timeline (seconds)
  const T = {
    fadeIn: 0.8,          // black to cockpit
    warpFrom: 0.9,        // start accelerating
    warpFull: 3.6,        // top speed
    stop: 4.4,            // brakes: speed falls to nothing in STOP_LEN
    heart: 4.9,           // planet comes into view...
    heartNear: 8.0,       // ...and has drifted close
    title: 7.0,           // "Fair Vitals" fades in
    flash: 9.6,           // last heartbeat floods the screen with light
    end: 10.3,            // the page appears
  };
  const STOP_LEN = 0.28, BPM = 66, BEAT = 60 / BPM;

  // ---------------------------------------------------------------- overlay
  const box = document.createElement('div');
  box.id = 'intro';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Intro animation');
  box.innerHTML = '<canvas aria-hidden="true"></canvas>'
    + '<div class="intro-title"><h1>Fair Vitals</h1><p>Your heart rate, from a 30-second selfie video.</p></div>'
    + '<button class="intro-skip" type="button">Skip</button>';
  document.body.prepend(box);
  const canvas = box.querySelector('canvas'), ctx = canvas.getContext('2d');
  const title = box.querySelector('.intro-title'), skip = box.querySelector('.intro-skip');

  let W, H, R, dpr;
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight; R = Math.min(W, H);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  addEventListener('resize', resize);

  // ---------------------------------------------------------------- helpers
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const ease = v => v * v * (3 - 2 * v);                         // smoothstep
  const easeOut = v => 1 - Math.pow(1 - v, 3);
  const lerp = (a, b, v) => a + (b - a) * v;
  const span = (t, a, b) => clamp01((t - a) / (b - a));

  /** Ship speed, 0..1. */
  function speed(t) {
    if (t < T.warpFrom) return 0.02;
    if (t < T.warpFull) return lerp(0.02, 1, Math.pow(span(t, T.warpFrom, T.warpFull), 2.2));
    if (t < T.stop) return 1;
    return lerp(1, 0.004, easeOut(span(t, T.stop, T.stop + STOP_LEN)));
  }

  // stars in a box in front of the ship: x, y in -1..1, depth z in 0..1 (0 = at the window)
  const STAR_TINTS = ['255,255,255', '246,233,204', '201,174,123', '190,222,208'];
  const stars = Array.from({ length: 1400 }, () => newStar(Math.random()));
  function newStar(z) {
    return { x: (Math.random() - 0.5) * 2.4, y: (Math.random() - 0.5) * 2.4, z, c: STAR_TINTS[Math.random() * 4 | 0] };
  }

  // ---------------------------------------------------------------- the heart planet
  function heartPath(cx, cy, r) {
    const s = r / 16.5;
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const a = i / 120 * Math.PI * 2, sa = Math.sin(a);
      const x = 16 * sa * sa * sa;
      const y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
      const px = cx + x * s, py = cy - (y - 2.5) * s;          // shift so the shape is centred on (cx, cy)
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  /** Strength of the heartbeat now: a strong "lub" then a softer "dub". 0..1 */
  function beat(t) {
    const p = (t % BEAT) / BEAT, g = (x, w) => Math.exp(-(x / w) * (x / w));
    return Math.max(g(p, 0.045), 0.6 * g(p - 0.19, 0.045), g(p - 1, 0.045));
  }

  function drawRing(cx, cy, r, front, alpha) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 1.85, r * 0.42, -0.32, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
    ctx.strokeStyle = `rgba(201,174,123,${0.75 * alpha})`;
    ctx.lineWidth = Math.max(1.2, r * 0.035);
    ctx.shadowColor = 'rgba(246,233,204,0.8)';
    ctx.shadowBlur = r * 0.12;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 2.1, r * 0.5, -0.32, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
    ctx.strokeStyle = `rgba(201,174,123,${0.3 * alpha})`;
    ctx.lineWidth = Math.max(1, r * 0.012);
    ctx.stroke();
    ctx.restore();
  }

  function drawHeart(t, cx, cy, r, alpha) {
    const b = beat(t), rr = r * (1 + 0.075 * b);

    // a ripple leaves the planet on every "lub"
    const age = (t % BEAT) / BEAT;
    ctx.save();
    ctx.globalAlpha = alpha * (1 - age) * 0.55;
    heartPath(cx, cy, rr * (1 + age * 1.6));
    ctx.strokeStyle = 'rgba(246,233,204,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // glow around it, stronger on each beat
    const glow = ctx.createRadialGradient(cx, cy, rr * 0.3, cx, cy, rr * 2.6);
    glow.addColorStop(0, `rgba(214,96,80,${(0.35 + 0.35 * b) * alpha})`);
    glow.addColorStop(0.45, `rgba(201,174,123,${0.12 * alpha})`);
    glow.addColorStop(1, 'rgba(201,174,123,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - rr * 2.6, cy - rr * 2.6, rr * 5.2, rr * 5.2);

    drawRing(cx, cy, rr, false, alpha);                         // back half of the ring, behind the planet

    ctx.save();
    ctx.globalAlpha = alpha;
    heartPath(cx, cy, rr);
    ctx.save();
    ctx.clip();
    // lit from the upper left like a planet: highlight, body, and a dark night side to the lower right
    const body = ctx.createRadialGradient(cx - rr * 0.45, cy - rr * 0.5, rr * 0.05, cx, cy, rr * 1.35);
    body.addColorStop(0, '#F7CDB0');
    body.addColorStop(0.25, '#D8645A');
    body.addColorStop(0.6, '#9E2F35');
    body.addColorStop(1, '#3A0B14');
    ctx.fillStyle = body;
    ctx.fillRect(cx - rr * 1.5, cy - rr * 1.5, rr * 3, rr * 3);
    // cloud bands drifting across the surface
    ctx.lineWidth = rr * 0.05;
    for (let i = -4; i <= 4; i++) {
      ctx.beginPath();
      for (let x = -1.3; x <= 1.3; x += 0.05) {
        const y = i * 0.22 + 0.05 * Math.sin(x * 4 + i * 1.7 + t * 0.35);
        const px = cx + x * rr, py = cy + y * rr;
        x === -1.3 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.strokeStyle = i % 2 ? 'rgba(255,214,190,0.10)' : 'rgba(58,11,20,0.16)';
      ctx.stroke();
    }
    // the night side and a bright rim where the light catches the edge
    const night = ctx.createLinearGradient(cx - rr, cy - rr, cx + rr, cy + rr);
    night.addColorStop(0.45, 'rgba(10,4,8,0)');
    night.addColorStop(1, 'rgba(10,4,8,0.65)');
    ctx.fillStyle = night;
    ctx.fillRect(cx - rr * 1.5, cy - rr * 1.5, rr * 3, rr * 3);
    ctx.restore();
    heartPath(cx, cy, rr);                                       // (the bands replaced the path) the bright rim
    ctx.strokeStyle = `rgba(255,224,200,${0.35 + 0.4 * b})`;
    ctx.lineWidth = Math.max(1, rr * 0.018);
    ctx.shadowColor = 'rgba(255,180,150,0.9)';
    ctx.shadowBlur = rr * (0.15 + 0.25 * b);
    ctx.stroke();
    ctx.restore();

    drawRing(cx, cy, rr, true, alpha);                          // front half of the ring, over the planet
  }

  // ---------------------------------------------------------------- the cockpit
  /** The window frame you look through, plus a small readout. Drawn over everything. */
  function drawCockpit(t, v, alpha) {
    const pts = [[0.07, 0.1], [0.93, 0.1], [0.985, 0.5], [0.9, 0.93], [0.1, 0.93], [0.015, 0.5]];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    ctx.closePath();
    ctx.fillStyle = '#020605';
    ctx.fill('evenodd');
    // gold edge of the window
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(201,174,123,0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // inner shadow so the glass has some depth
    const vg = ctx.createRadialGradient(W / 2, H / 2, R * 0.35, W / 2, H / 2, Math.max(W, H) * 0.65);
    vg.addColorStop(0, 'rgba(2,6,5,0)');
    vg.addColorStop(1, 'rgba(2,6,5,0.7)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    // readout in the lower left of the window
    const x = W * 0.12, y = H * 0.86, small = Math.max(10, Math.round(R * 0.018));
    ctx.font = `600 ${small}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(201,174,123,0.75)';
    ctx.fillText('SPEED', x, y - small * 1.6);
    ctx.font = `500 ${Math.round(small * 1.5)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(246,233,204,0.9)';
    ctx.fillText(`${(v * 0.99).toFixed(2)} c`, x, y);
    ctx.fillStyle = 'rgba(201,174,123,0.25)';
    ctx.fillRect(x, y + small * 0.7, small * 9, 2);
    ctx.fillStyle = 'rgba(246,233,204,0.85)';
    ctx.fillRect(x, y + small * 0.7, small * 9 * v, 2);
    if (t > T.heart + 0.6) {                                    // the heartbeat shows up on the readout
      const a = clamp01((t - T.heart - 0.6) / 0.6);
      ctx.globalAlpha = alpha * a;
      ctx.textAlign = 'right';
      ctx.font = `600 ${small}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(201,174,123,0.75)';
      ctx.fillText('SIGNAL', W * 0.88, y - small * 1.6);
      ctx.font = `500 ${Math.round(small * 1.5)}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = `rgba(246,233,204,${0.55 + 0.45 * beat(t)})`;
      ctx.fillText(`${BPM} BPM`, W * 0.88, y);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- one frame
  let clock = 0, last = performance.now(), done = false;
  function frame(now) {
    if (done) return;
    const dt = Math.min((now - last) / 1000, 0.05);             // a background tab doesn't skip the show
    clock += dt;
    last = now;
    const t = clock, v = speed(t);

    // shake: rises with speed, kicks hard at the stop, then settles
    const kick = Math.exp(-Math.max(0, t - T.stop) * 7) * (t > T.stop ? 1 : 0);
    const shake = R * (0.0025 * v * v + 0.012 * kick);
    const cx = W / 2 + (Math.random() - 0.5) * shake, cy = H / 2 + (Math.random() - 0.5) * shake;
    const f = R * 0.55;

    ctx.fillStyle = '#020605';
    ctx.fillRect(0, 0, W, H);

    // light ahead of the ship at full speed
    if (v > 0.2) {
      const tunnel = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
      tunnel.addColorStop(0, `rgba(246,233,204,${0.22 * v})`);
      tunnel.addColorStop(0.4, `rgba(127,168,148,${0.08 * v})`);
      tunnel.addColorStop(1, 'rgba(2,6,5,0)');
      ctx.fillStyle = tunnel;
      ctx.fillRect(0, 0, W, H);
    }

    // stars: streaks at speed, points when still
    const dz = (v * 1.4 + 0.012) * dt;                          // depth travelled this frame
    ctx.lineCap = 'round';
    for (const s of stars) {
      s.z -= dz;
      if (s.z <= 0.03) Object.assign(s, newStar(1));
      const px = cx + s.x / s.z * f * 0.5, py = cy + s.y / s.z * f * 0.5;
      if (px < -50 || px > W + 50 || py < -50 || py > H + 50) continue;
      const near = 1 - s.z, a = Math.min(1, near * 1.4);
      const tz = Math.min(1, s.z * (1 + v * 0.9) + v * 0.05);     // tail: none when still, long at warp
      const tx = cx + s.x / tz * f * 0.5, ty = cy + s.y / tz * f * 0.5;
      ctx.strokeStyle = `rgba(${s.c},${a})`;
      ctx.lineWidth = 0.6 + near * 1.8;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(px + 0.01, py); ctx.stroke();
    }

    // the stop: a white flash that fades
    if (t > T.stop) {
      const flash = Math.exp(-(t - T.stop) * 6) * 0.55;
      ctx.fillStyle = `rgba(246,233,204,${flash})`;
      ctx.fillRect(0, 0, W, H);
    }

    // the heart planet drifts closer and beats
    if (t > T.heart) {
      const a = easeOut(span(t, T.heart, T.heartNear));
      drawHeart(t, W / 2, H * 0.44, lerp(R * 0.02, R * 0.16, a), clamp01((t - T.heart) / 0.8));
    }

    drawCockpit(t, v, 1 - span(t, T.flash, T.flash + 0.4));
    if (t < T.fadeIn) {                                           // the view fades in from black
      ctx.fillStyle = `rgba(2,6,5,${1 - ease(t / T.fadeIn)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // the last beat floods the screen
    if (t > T.flash) {
      const k = ease(span(t, T.flash, T.end));
      const g = ctx.createRadialGradient(W / 2, H * 0.44, 0, W / 2, H * 0.44, Math.max(W, H) * (0.2 + 1.2 * k));
      g.addColorStop(0, `rgba(255,240,224,${k})`);
      g.addColorStop(0.6, `rgba(246,233,204,${0.8 * k})`);
      g.addColorStop(1, `rgba(201,174,123,${0.6 * k})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    if (t > T.title && !title.classList.contains('show')) title.classList.add('show');
    if (t > T.flash && title.classList.contains('show')) title.classList.add('gone');
    if (t >= T.end) { finish(); return; }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- end / skip
  function finish() {
    if (done) return;
    done = true;
    remember();
    root.classList.remove('intro-on');                            // the page shows underneath...
    box.classList.add('leaving');                                 // ...as the overlay fades out
    const remove = () => { box.remove(); removeEventListener('resize', resize); removeEventListener('keydown', onKey); };
    box.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 1500);                                     // in case the transition doesn't run
  }
  function onKey(e) { if (e.key === 'Escape') finish(); }
  skip.onclick = finish;
  addEventListener('keydown', onKey);
  skip.focus({ preventScroll: true });
  requestAnimationFrame(frame);
})();
