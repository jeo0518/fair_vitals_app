// First-visit intro: a first-person flight through space. You drift through a nebula, accelerate to warp
// speed, stop dead, and in the silence a transparent golden heart beats in front of you; "We invite you
// to Fair Vitals" appears and the site fades in. Drawn live on a canvas (no video file), about 20 seconds.
// The small script in each page's <head> adds html.intro-on for first-time visitors (or when the address
// has ?intro), which hides the page until this finishes. It always plays to the end (no skipping), except
// that with reduced motion it never plays.
(() => {
  const root = document.documentElement, KEY = 'fv-intro-seen';
  if (!root.classList.contains('intro-on')) return;
  const remember = () => { try { localStorage.setItem(KEY, '1'); } catch { /* private mode: it may play again */ } };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { remember(); root.classList.remove('intro-on'); return; }

  // ---------------------------------------------------------------- timeline (seconds)
  const T = {
    fadeIn: 2.2,          // black to space
    warpFrom: 3.6,        // start accelerating...
    warpFull: 8.0,        // ...to full warp
    stop: 8.9,            // the brakes: speed falls to nothing in STOP_LEN
    heart: 10.2,          // a glow ahead becomes the heart...
    heartNear: 15.5,      // ...which drifts close
    line1: 14.6,          // "We invite you to"
    line2: 15.8,          // "Fair Vitals"
    bloom: 18.7,          // the last heartbeat floods the screen with light
    end: 19.9,            // the page appears
  };
  const STOP_LEN = 0.35, BPM = 60, BEAT = 60 / BPM;

  // ---------------------------------------------------------------- overlay
  const box = document.createElement('div');
  box.id = 'intro';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Intro animation');
  box.innerHTML = '<canvas aria-hidden="true"></canvas>'
    + '<div class="intro-title"><p class="intro-l1">We invite you to</p><h1 class="intro-l2">Fair Vitals</h1></div>';
  document.body.prepend(box);
  const canvas = box.querySelector('canvas'), ctx = canvas.getContext('2d');
  const line1 = box.querySelector('.intro-l1'), line2 = box.querySelector('.intro-l2');

  let W, H, R, dpr, nebula, vignette;
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight; R = Math.min(W, H);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    nebula = makeNebula();
    vignette = makeVignette();
  }

  // ---------------------------------------------------------------- helpers
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const smooth = v => v * v * (3 - 2 * v);
  const easeOut = v => 1 - Math.pow(1 - v, 3);
  const easeInOut = v => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2);
  const lerp = (a, b, v) => a + (b - a) * v;
  const span = (t, a, b) => clamp01((t - a) / (b - a));
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);   // repeatable, so the sky is the same every time

  /** A soft round glow, drawn once and reused (much cheaper than shadows). */
  function sprite(rgb, size = 64) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d'), grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${rgb},1)`); grad.addColorStop(0.25, `rgba(${rgb},0.45)`); grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
    return c;
  }
  const GOLD = sprite('255,214,140'), WHITE = sprite('255,250,240'), TEAL = sprite('150,215,195');

  /** Faint clouds of gold and green gas, painted once per screen size. */
  function makeNebula() {
    const c = document.createElement('canvas'), s = 0.5;          // half resolution: it's blurry anyway
    c.width = Math.ceil(W * 1.4 * s); c.height = Math.ceil(H * 1.4 * s);
    const g = c.getContext('2d'), cw = c.width, ch = c.height;
    seed = 11;
    const clouds = [['201,174,123', 0.10], ['47,107,79', 0.16], ['127,168,148', 0.08], ['180,110,90', 0.05]];
    for (let i = 0; i < 26; i++) {
      const [rgb, a] = clouds[i % clouds.length], x = rand() * cw, y = ch * (0.15 + rand() * 0.7), r = (0.12 + rand() * 0.3) * Math.max(cw, ch);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${rgb},${a})`); grad.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grad; g.fillRect(0, 0, cw, ch);
    }
    for (let i = 0; i < 900; i++) {                                // far-away stars baked into the clouds
      g.fillStyle = `rgba(255,248,235,${0.15 + rand() * 0.5})`;
      const big = rand() < 0.08;
      g.fillRect(rand() * cw, rand() * ch, big ? 1.5 : 0.8, big ? 1.5 : 0.8);
    }
    return c;
  }

  /** Dark edges, like a film frame; painted once per screen size. */
  function makeVignette() {
    const c = document.createElement('canvas'), s = 0.5;
    c.width = Math.ceil(W * s); c.height = Math.ceil(H * s);
    const g = c.getContext('2d'), vg = g.createRadialGradient(c.width / 2, c.height / 2, R * s * 0.3, c.width / 2, c.height / 2, Math.hypot(c.width, c.height) * 0.55);
    vg.addColorStop(0, 'rgba(1,4,3,0)'); vg.addColorStop(1, 'rgba(1,4,3,0.75)');
    g.fillStyle = vg; g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  // ---------------------------------------------------------------- the ship's motion
  /** Speed, 0..1. */
  function speed(t) {
    if (t < T.warpFrom) return 0.035;
    if (t < T.warpFull) return lerp(0.035, 1, Math.pow(span(t, T.warpFrom, T.warpFull), 2.4));
    if (t < T.stop) return 1;
    return lerp(1, 0.003, easeOut(span(t, T.stop, T.stop + STOP_LEN)));
  }

  // stars in a box ahead: x, y in -1.2..1.2, depth z in 0..1 (0 = right in front of you)
  const TINTS = ['255,255,255', '255,240,214', '232,206,150', '190,222,208', '170,200,255'];
  seed = 3;
  const newStar = z => ({ x: (rand() - 0.5) * 2.4, y: (rand() - 0.5) * 2.4, z, ci: rand() * TINTS.length | 0 });
  const stars = Array.from({ length: 1500 }, () => newStar(rand()));
  const BANDS = 5, starPaths = Array.from({ length: TINTS.length * BANDS }, () => []);   // line ends per colour and depth band
  const newDust = z => ({ x: (rand() - 0.5) * 1.6, y: (rand() - 0.5) * 1.6, z, s: 0.5 + rand() });
  const dust = Array.from({ length: 70 }, () => newDust(rand()));

  // golden specks circling the heart; each beat pushes them outward a little
  const motes = Array.from({ length: 170 }, () => ({ a: rand() * 6.283, r: 0.75 + rand() * 1.5, tilt: (rand() - 0.5) * 0.9,
                                                     sp: (0.08 + rand() * 0.18) * (rand() < 0.5 ? 1 : -1), s: 0.4 + rand() * 1.1 }));

  // ---------------------------------------------------------------- the heart
  /** Strength of the heartbeat now: a strong "lub" then a softer "dub". 0..1 */
  function beat(t) {
    const p = ((t - T.heart) % BEAT + BEAT) % BEAT / BEAT, g = (x, w) => Math.exp(-(x / w) * (x / w));
    return Math.max(g(p, 0.05), 0.6 * g(p - 0.2, 0.05), g(p - 1, 0.05));
  }

  // In heart units: about 400 tall, centred near (0, 0). Front view: the apex points down and to the right.
  function ventricles() {
    ctx.beginPath();
    ctx.moveTo(-70, -12);
    ctx.bezierCurveTo(-86, 42, -55, 98, 24, 128);
    ctx.bezierCurveTo(58, 142, 86, 112, 89, 70);
    ctx.bezierCurveTo(93, 24, 80, -26, 55, -46);
    ctx.bezierCurveTo(30, -61, -10, -56, -30, -46);
    ctx.bezierCurveTo(-50, -39, -62, -31, -70, -12);
    ctx.closePath();
  }
  const VESSELS = [
    // [path, width, behind the heart?]
    [() => { ctx.moveTo(-74, -55); ctx.bezierCurveTo(-74, -95, -70, -125, -68, -160); }, 24, false],           // superior vena cava
    [() => { ctx.moveTo(-78, 18); ctx.lineTo(-84, 58); }, 22, true],                                            // inferior vena cava
    [() => { ctx.moveTo(-10, -86); ctx.bezierCurveTo(-40, -92, -70, -92, -96, -86); }, 15, true],              // right pulmonary artery
    [() => { ctx.moveTo(-8, -46); ctx.lineTo(-10, -96); ctx.bezierCurveTo(-10, -152, 58, -156, 62, -106); ctx.lineTo(64, -58); }, 26, false], // aorta
    [() => { ctx.moveTo(6, -138); ctx.bezierCurveTo(2, -158, 0, -175, -4, -196); }, 11, false],                // brachiocephalic artery
    [() => { ctx.moveTo(24, -146); ctx.bezierCurveTo(24, -165, 26, -182, 28, -200); }, 9, false],              // left common carotid
    [() => { ctx.moveTo(42, -140); ctx.bezierCurveTo(48, -160, 56, -176, 64, -192); }, 10, false],             // left subclavian
    [() => { ctx.moveTo(14, -44); ctx.bezierCurveTo(22, -62, 30, -78, 36, -92); }, 24, false],                 // pulmonary trunk
    [() => { ctx.moveTo(36, -92); ctx.bezierCurveTo(56, -100, 80, -100, 104, -94); }, 14, false],              // left pulmonary artery
  ];
  const CORONARY = [
    () => { ctx.moveTo(22, -46); ctx.bezierCurveTo(34, 0, 40, 60, 48, 122); },                                 // down the front groove to the apex
    () => { ctx.moveTo(30, 0); ctx.bezierCurveTo(48, 10, 64, 24, 78, 44); },
    () => { ctx.moveTo(38, 52); ctx.bezierCurveTo(54, 62, 68, 76, 80, 96); },
    () => { ctx.moveTo(34, 20); ctx.bezierCurveTo(16, 34, 4, 50, -6, 70); },
    () => { ctx.moveTo(-18, -48); ctx.bezierCurveTo(-56, -26, -66, 20, -40, 78); },                           // right coronary artery
    () => { ctx.moveTo(-56, 2); ctx.bezierCurveTo(-36, 12, -20, 22, -6, 40); },
    () => { ctx.moveTo(-50, 48); ctx.bezierCurveTo(-30, 60, -10, 78, 6, 104); },
  ];

  function stroke(pathFn, width, color) {
    ctx.beginPath(); pathFn(); ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
  }

  /** A see-through golden blood vessel: a faint body, a shine down one side and a darker edge down the other. */
  function vessel(pathFn, w, a) {
    stroke(pathFn, w, `rgba(255,200,120,${0.10 * a})`);
    stroke(pathFn, w * 0.62, `rgba(255,214,150,${0.08 * a})`);
    ctx.save(); ctx.translate(-w * 0.22, -w * 0.12);
    stroke(pathFn, 1.3, `rgba(255,236,196,${0.55 * a})`);
    ctx.restore();
    ctx.save(); ctx.translate(w * 0.3, w * 0.15);
    stroke(pathFn, 1, `rgba(232,190,120,${0.35 * a})`);
    ctx.restore();
  }

  function drawHeart(t, cx, cy, size, alpha) {
    const b = beat(t), k = size / 400;
    ctx.save();
    ctx.translate(cx, cy + size * 0.08);
    ctx.rotate(0.12 * Math.sin(t * 0.21) - 0.06);                  // a slow turn and sway, as if floating
    ctx.scale(k * (0.9 + 0.08 * Math.cos(t * 0.33)), k);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    for (const [p, w, behind] of VESSELS) if (behind) vessel(p, w, alpha * 0.55);

    // the ventricles swell on each beat (from their centre), the vessels much less
    ctx.save();
    ctx.translate(10, 40); ctx.scale(1 + 0.07 * b, 1 + 0.06 * b); ctx.translate(-10, -40);
    const body = ctx.createRadialGradient(-20, -10, 10, 10, 30, 150);
    body.addColorStop(0, `rgba(255,226,170,${0.30 * alpha})`);
    body.addColorStop(0.5, `rgba(214,170,90,${0.12 * alpha})`);
    body.addColorStop(1, `rgba(255,205,120,${0.26 * alpha})`);    // brighter at the edge, like glass
    ventricles(); ctx.fillStyle = body; ctx.fill();
    // the atria: the right one at the viewer's left, the left one's small ear at the upper right
    ctx.beginPath(); ctx.ellipse(-74, -30, 30, 38, -0.2, 0, 6.283);
    ctx.fillStyle = `rgba(255,214,150,${0.10 * alpha})`; ctx.fill();
    ctx.strokeStyle = `rgba(255,226,180,${0.45 * alpha})`; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(70, -44, 20, 11, -0.5, 0, 6.283);
    ctx.fillStyle = `rgba(255,214,150,${0.12 * alpha})`; ctx.fill(); ctx.stroke();
    // what you can see through the glass: the wall between the chambers and two valve rings
    ctx.setLineDash([3, 5]);
    stroke(() => { ctx.moveTo(14, -40); ctx.bezierCurveTo(8, 10, 20, 70, 40, 118); }, 1.2, `rgba(255,226,180,${0.30 * alpha})`);
    ctx.setLineDash([]);
    for (const [x, y, rx, ry] of [[-28, -26, 18, 8], [30, -30, 16, 7]]) {
      ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0.2, 0, 6.283);
      ctx.strokeStyle = `rgba(255,226,180,${0.28 * alpha})`; ctx.lineWidth = 1.2; ctx.stroke();
    }
    // a bright rim, brighter on the beat
    ventricles();
    ctx.strokeStyle = `rgba(255,232,190,${(0.65 + 0.35 * b) * alpha})`; ctx.lineWidth = 2.2; ctx.stroke();
    ctx.strokeStyle = `rgba(255,200,120,${0.18 * alpha})`; ctx.lineWidth = 9; ctx.stroke();
    // the coronary arteries on the surface
    for (const p of CORONARY) stroke(p, 2, `rgba(255,236,200,${(0.45 + 0.4 * b) * alpha})`);
    ctx.restore();

    for (const [p, w, behind] of VESSELS) if (!behind) vessel(p, w, alpha);
    // the open ends of the vessels, seen as rings
    for (const [x, y, rx] of [[-68, -160, 12], [-4, -196, 5.5], [28, -200, 4.5], [64, -192, 5], [104, -94, 7], [-96, -86, 7]]) {
      ctx.beginPath(); ctx.ellipse(x, y, rx, rx * 0.45, 0, 0, 6.283);
      ctx.strokeStyle = `rgba(255,230,190,${0.5 * alpha})`; ctx.lineWidth = 1.2; ctx.stroke();
    }

    // sparkles drifting over the surface
    for (let i = 0; i < 14; i++) {
      const u = (i * 0.618 + t * 0.05) % 1, x = -60 + 140 * ((i * 0.37) % 1), y = -40 + 160 * u;
      const s = 6 + 10 * Math.max(0, Math.sin(t * 2 + i));
      ctx.globalAlpha = 0.5 * alpha * Math.sin(u * Math.PI);
      ctx.drawImage(WHITE, x - s / 2, y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ---------------------------------------------------------------- one frame
  let clock = 0, last = performance.now(), done = false, roll = 0, beatsSeen = 0, push = 0, stopped = false;
  let frameTime = 1 / 60, lite = false;                             // lite: half the stars and no dust, for slow computers
  const waves = [];                                                 // rings sent out by the stop and by each beat

  function frame(now) {
    if (done) return;
    const dt = Math.min((now - last) / 1000, 0.05);                 // a background tab doesn't skip the show
    clock += dt; last = now;
    const t = clock, v = speed(t);
    frameTime += (dt - frameTime) * 0.05;
    if (!lite && t > 2 && frameTime > 0.028) lite = true;          // can't keep up (under ~35 frames a second): draw less

    // camera: shakes with speed, jolts at the stop, rolls a little at warp, then floats
    const kick = t > T.stop ? Math.exp(-(t - T.stop) * 5) : 0;
    const shake = R * (0.003 * v * v + 0.016 * kick);
    roll += dt * v * v * 0.35;
    const cx = W / 2 + (Math.random() - 0.5) * shake + Math.sin(t * 0.4) * R * 0.006;
    const cy = H / 2 + (Math.random() - 0.5) * shake + Math.cos(t * 0.31) * R * 0.005;
    const fov = R * lerp(0.62, 0.42, v);                            // the view widens as you speed up

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#010403';
    ctx.fillRect(0, 0, W, H);

    // nebula: drifts slowly, rushes past and dims at warp, settles after the stop
    const nz = 1 + 0.25 * v + 0.04 * Math.sin(t * 0.1);
    ctx.globalAlpha = lerp(1, 0.55, v);
    ctx.drawImage(nebula, cx - W * 0.7 * nz, cy - H * 0.7 * nz, W * 1.4 * nz, H * 1.4 * nz);
    ctx.globalAlpha = 1;

    ctx.globalCompositeOperation = 'lighter';
    // light ahead of you at warp
    if (v > 0.15) {
      const s = R * (0.4 + 1.1 * v);
      ctx.globalAlpha = 0.5 * v * v; ctx.drawImage(WHITE, cx - s / 2, cy - s / 2, s, s);
      ctx.globalAlpha = 0.35 * v; ctx.drawImage(TEAL, cx - s * 0.6, cy - s * 0.6, s * 1.2, s * 1.2);
      ctx.globalAlpha = 1;
    }

    // stars: points while drifting, long streaks at warp. Drawn in batches (one path per colour and
    // depth band) instead of one line at a time, which keeps warp smooth on slower computers.
    const dz = (v * 1.5 + 0.01) * dt, cr = Math.cos(roll), sr = Math.sin(roll);
    for (const path of starPaths) path.length = 0;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      s.z -= dz;
      if (s.z <= 0.025) Object.assign(s, newStar(1));
      if (lite && i & 1) continue;
      const x = s.x * cr - s.y * sr, y = s.x * sr + s.y * cr;
      const px = cx + x / s.z * fov * 0.5, py = cy + y / s.z * fov * 0.5;
      if (px < -60 || px > W + 60 || py < -60 || py > H + 60) continue;
      const tz = Math.min(1, s.z * (1 + v * 1.1) + v * 0.06);       // tail: none when still, long at warp
      const band = Math.min(BANDS - 1, (1 - s.z) * BANDS | 0);
      starPaths[s.ci * BANDS + band].push(cx + x / tz * fov * 0.5, cy + y / tz * fov * 0.5, px + 0.01, py);
    }
    ctx.globalCompositeOperation = 'source-over';                    // plain blending: looks the same on black, draws faster
    ctx.lineCap = 'round';
    const twinkle = 0.9 + 0.1 * Math.sin(t * 3);
    starPaths.forEach((path, i) => {
      if (!path.length) return;
      const band = i % BANDS, near = (band + 0.5) / BANDS;
      ctx.strokeStyle = `rgba(${TINTS[i / BANDS | 0]},${Math.min(1, near * 1.5) * twinkle})`;
      ctx.lineWidth = 0.5 + near * near * 2;
      ctx.beginPath();
      for (let j = 0; j < path.length; j += 4) { ctx.moveTo(path[j], path[j + 1]); ctx.lineTo(path[j + 2], path[j + 3]); }
      ctx.stroke();
    });
    ctx.globalCompositeOperation = 'lighter';
    // big soft dust rushing past close by
    for (const d of lite ? [] : dust) {
      d.z -= dz * 1.4;
      if (d.z <= 0.05) Object.assign(d, newDust(1));
      const px = cx + d.x / d.z * fov * 0.5, py = cy + d.y / d.z * fov * 0.5, s = Math.min(R * 0.12, d.s * R * 0.05 * (1 - d.z) * (1 + 3 * v));
      ctx.globalAlpha = 0.18 * (1 - d.z) * (0.3 + v);
      ctx.drawImage(GOLD, px - s / 2, py - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    // the stop: a flash, and a shockwave ring
    if (t > T.stop && !stopped) { stopped = true; waves.push({ at: t, x: W / 2, y: H / 2, big: true }); }
    if (t > T.stop) {
      const f = Math.exp(-(t - T.stop) * 5) * 0.7;
      ctx.fillStyle = `rgba(255,244,226,${f})`; ctx.fillRect(0, 0, W, H);
    }

    // the heart: first a far glow, then it drifts close and beats
    const hx = W / 2, hy = H * 0.4;
    if (t > T.heart - 1.2) {
      const glow = clamp01((t - T.heart + 1.2) / 1.5);
      const near = easeInOut(span(t, T.heart, T.heartNear));
      const full = Math.min(W * 0.95, H * 0.62);                 // as big as fits: fills a phone held upright too
      const size = full * lerp(0.1, 1, near), a = clamp01((t - T.heart) / 1.4), b = t > T.heart ? beat(t) : 0;
      // count beats: each "lub" sends a ring outward and pushes the specks
      const n = t > T.heart ? Math.floor((t - T.heart) / BEAT) + 1 : 0;
      if (n > beatsSeen) { beatsSeen = n; waves.push({ at: t, x: hx, y: hy, big: false, r0: size * 0.35 }); push = 1; }
      push *= Math.exp(-dt * 3);

      const gs = size * (2.2 + 0.5 * b);
      ctx.globalAlpha = (0.25 + 0.25 * b) * glow; ctx.drawImage(GOLD, hx - gs / 2, hy - gs / 2, gs, gs);
      // a wide lens flare through the heart, brighter on the beat
      ctx.globalAlpha = (0.12 + 0.3 * b) * glow;
      ctx.drawImage(GOLD, hx - size * 2.6, hy - size * 0.04, size * 5.2, size * 0.08);
      ctx.drawImage(WHITE, hx - size * 1.4, hy - size * 0.015, size * 2.8, size * 0.03);
      ctx.globalAlpha = 1;

      // specks circling the heart, in front and behind
      for (const m of motes) {
        m.a += m.sp * dt;
        const rr = size * 0.55 * m.r * (1 + 0.25 * push), x = Math.cos(m.a) * rr, z = Math.sin(m.a);
        const px = hx + x, py = hy + (z * rr * 0.28 + x * m.tilt * 0.4), s = m.s * R * 0.012 * (1.2 + 0.4 * z);
        ctx.globalAlpha = a * (0.35 + 0.35 * (z + 1) / 2) * (0.7 + 0.3 * b);
        ctx.drawImage(GOLD, px - s / 2, py - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
      if (a > 0) drawHeart(t, hx, hy, size, a);
    }

    // rings: the stop's shockwave, and one per heartbeat
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i], age = t - w.at, life = w.big ? 1.6 : 2.2;
      if (age > life) { waves.splice(i, 1); continue; }
      const p = age / life, r = w.big ? Math.max(W, H) * easeOut(p) : w.r0 + R * 0.7 * easeOut(p);
      ctx.beginPath(); ctx.ellipse(w.x, w.y, r, r * (w.big ? 1 : 0.9), 0, 0, 6.283);
      ctx.strokeStyle = w.big ? `rgba(255,244,226,${0.5 * (1 - p)})` : `rgba(255,214,150,${0.45 * (1 - p) * (1 - p)})`;
      ctx.lineWidth = w.big ? 3 + 10 * (1 - p) : 1.5 + 3 * (1 - p);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';
    // the look of a film: dark edges
    ctx.drawImage(vignette, 0, 0, W, H);
    if (t < T.fadeIn) { ctx.fillStyle = `rgba(1,4,3,${1 - smooth(t / T.fadeIn)})`; ctx.fillRect(0, 0, W, H); }

    // the last beat: warm light floods the screen
    if (t > T.bloom) {
      const k = smooth(span(t, T.bloom, T.end));
      const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, Math.hypot(W, H) * (0.15 + 0.9 * k));
      g.addColorStop(0, `rgba(255,244,228,${k})`); g.addColorStop(0.55, `rgba(246,233,204,${0.85 * k})`); g.addColorStop(1, `rgba(201,174,123,${0.7 * k})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    if (t > T.line1) line1.classList.add('show');
    if (t > T.line2) line2.classList.add('show');
    if (t > T.bloom + 0.4) { line1.classList.add('gone'); line2.classList.add('gone'); }
    if (t >= T.end) { finish(); return; }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- end
  function finish() {
    if (done) return;
    done = true;
    remember();
    root.classList.remove('intro-on');                              // the page shows underneath...
    box.classList.add('leaving');                                   // ...as the overlay fades out
    const remove = () => { box.remove(); removeEventListener('resize', resize); };
    box.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 1500);                                       // in case the transition doesn't run
  }
  resize();
  addEventListener('resize', resize);
  requestAnimationFrame(frame);
})();
