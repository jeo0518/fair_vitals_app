// Shared by every page: card effects, the header logo's shadow, and the space background.
// Cards: add the effect layers (glow, turning border, white surface with sheen and cursor light) to every
// .card, so the pages only need <div class="card">. Every card glows while the cursor is inside it, with
// a soft light following the cursor. Cards marked data-tilt also tilt so the spot under the cursor dips
// away, as if pressed there (starting a little outside the card). The tilt eases toward the cursor once
// per animation frame, so it stays smooth however fast the mouse moves. Mouse only; no tilt with
// reduced motion.
(() => {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = v => Math.max(-1, Math.min(1, v));
  const NEAR = 60, MAX = 4, EASE = 0.12;          // px around the card, max degrees, share of the gap closed per frame

  for (const card of document.querySelectorAll('.card')) {
    card.insertAdjacentHTML('afterbegin',
      '<div class="card-fx card-glow" aria-hidden="true"></div>' +
      '<div class="card-fx card-spin" aria-hidden="true"></div>' +
      '<div class="card-fx card-surface" aria-hidden="true"><div class="card-pearl"></div><div class="card-spot"></div></div>');
    const spot = card.querySelector('.card-spot'), spin = card.querySelector('.card-spin');
    // the turning border is a square spun behind the card: make it as wide as the card's diagonal
    new ResizeObserver(() => spin.style.setProperty('--spin', `${Math.ceil(Math.hypot(card.offsetWidth, card.offsetHeight)) + 8}px`)).observe(card);
    if (!card.hasAttribute('data-tilt')) {
      card.addEventListener('pointermove', e => {
        if (e.pointerType !== 'mouse') return;
        const r = card.getBoundingClientRect();
        card.classList.add('glow');
        spot.style.transform = `translate3d(${e.clientX - r.left}px, ${e.clientY - r.top}px, 0)`;
      }, { passive: true });
      card.addEventListener('pointerleave', () => card.classList.remove('glow'));
      continue;
    }

    const target = { rx: 0, ry: 0, s: 1 }, now = { rx: 0, ry: 0, s: 1 };
    let box = null, running = false;
    // untransformed position (from the card's offset parent), so the tilt itself doesn't move the target
    function measure() {
      const op = card.offsetParent;
      if (!op) return;                              // hidden (e.g. the home page's turned-over upload card)
      const base = op.getBoundingClientRect();
      box = { left: base.left + op.clientLeft + card.offsetLeft, top: base.top + op.clientTop + card.offsetTop,
              w: card.offsetWidth, h: card.offsetHeight };
    }
    function step() {
      let moving = false;
      for (const k of ['rx', 'ry', 's']) {
        const d = target[k] - now[k];
        if (Math.abs(d) > (k === 's' ? 0.0002 : 0.01)) { now[k] += d * EASE; moving = true; } else now[k] = target[k];
      }
      card.style.transform = now.rx || now.ry || now.s !== 1
        ? `rotateX(${now.rx.toFixed(3)}deg) rotateY(${now.ry.toFixed(3)}deg) scale(${now.s.toFixed(4)})` : '';
      running = moving;
      if (moving) requestAnimationFrame(step);
    }
    const kick = () => { if (!running) { running = true; requestAnimationFrame(step); } };
    function aim(rx, ry, s) { target.rx = rx; target.ry = ry; target.s = s; if (!still) kick(); }

    addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      if (card.classList.contains('hold-still')) { aim(0, 0, 1); return; }   // e.g. while the camera is filming
      if (!box) measure();
      if (!box) return;
      const x = e.clientX - box.left, y = e.clientY - box.top;
      if (x < -NEAR || y < -NEAR || x > box.w + NEAR || y > box.h + NEAR) {
        card.classList.remove('glow'); aim(0, 0, 1); return;
      }
      const inside = x >= 0 && y >= 0 && x <= box.w && y <= box.h;
      card.classList.toggle('glow', inside);
      if (inside) spot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      aim(-clamp((y - box.h / 2) / (box.h / 2)) * MAX, clamp((x - box.w / 2) / (box.w / 2)) * MAX, inside ? 0.99 : 1);
    }, { passive: true });
    // the card moves or changes size: measure again on the next mouse move
    for (const ev of ['scroll', 'resize']) addEventListener(ev, () => { box = null; }, { passive: true });
    new ResizeObserver(() => { box = null; }).observe(card);
    document.documentElement.addEventListener('mouseleave', () => { card.classList.remove('glow'); aim(0, 0, 1); });
  }
})();

// Inner blocks and buttons: the first time each one scrolls into view it rises into place and glows
// briefly; siblings follow one after another. Content added later (the analysis result) can call
// window.revealIn(element). Skipped entirely with reduced motion, so everything just shows.
(() => {
  const SELECTOR = '.point, .stat, .note, .pipe-step, .pipe-window, table.data, .btn, .tips, .verdict, .meter, details';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    window.revealIn = () => {};
    return;
  }
  const seen = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('seen');
      seen.unobserve(e.target);
    }
  }, { threshold: 0 });
  window.revealIn = root => {
    const order = new Map();                       // stagger siblings: 0, 90, 180 ... ms, at most 450
    for (const el of root.querySelectorAll(SELECTOR)) {
      if (el.classList.contains('reveal') || el.closest('.reveal')) continue;   // don't animate inside an animating block
      const i = order.get(el.parentElement) || 0;
      order.set(el.parentElement, i + 1);
      el.style.setProperty('--d', `${Math.min(i * 90, 450)}ms`);
      el.classList.add('reveal');
      seen.observe(el);
    }
  };
  revealIn(document);
})();

// Inner boxes: tell each box under the cursor where it is, for the soft light that follows it (site.css).
// A diagram step sits inside the "every 10-second window" box, so both get the position.
const LIT = '.point, .stat, .note, .tips, .pipe-step, .pipe-window';
addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse' || !e.target.closest) return;
  for (let box = e.target.closest(LIT); box; box = box.parentElement && box.parentElement.closest(LIT)) {
    const r = box.getBoundingClientRect();
    box.style.setProperty('--mx', `${e.clientX - r.left}px`);
    box.style.setProperty('--my', `${e.clientY - r.top}px`);
  }
}, { passive: true });

// Header: the logo's shadow drifts away from the cursor, as if the cursor were a light.
(() => {
  const header = document.querySelector('.header'), logo = document.querySelector('.header-image');
  const MAX = 8, REACH = 160;      // px of shadow offset, px of cursor distance for the full offset
  header.addEventListener('mousemove', e => {
    const b = logo.getBoundingClientRect();
    const dx = e.clientX - (b.left + b.width / 2), dy = e.clientY - (b.top + b.height / 2);
    const d = Math.hypot(dx, dy) || 1, k = Math.min(d / REACH, 1) * MAX / d;
    header.style.setProperty('--sx', `${(-dx * k).toFixed(1)}px`);
    header.style.setProperty('--sy', `${(-dy * k).toFixed(1)}px`);
  });
  header.addEventListener('mouseleave', () => {
    header.style.removeProperty('--sx'); header.style.removeProperty('--sy');
  });
})();

// Background: stars at many depths drifting toward the viewer, and gold rings turning in 3D.
// Moving the mouse tilts the view a little (parallax), so nearer things shift more.
(() => {
  const canvas = document.getElementById('space'), ctx = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W, H, F, stars = [];
  const mouse = { x: 0, y: 0 }, cam = { x: 0, y: 0 };
  const rings = [
    { x: -0.9, y: -0.35, z: 2.2, r: 0.55, ax: 1.1, ay: 0.3, sx: 0.00012, sy: 0.00020, a: 0.30 },
    { x: 1.0, y: 0.45, z: 2.8, r: 0.80, ax: 0.5, ay: 1.2, sx: -0.00009, sy: 0.00014, a: 0.22 },
    { x: 0.35, y: -0.75, z: 3.6, r: 0.35, ax: 1.4, ay: 0.8, sx: 0.00016, sy: -0.00011, a: 0.26 },
    { x: -0.4, y: 0.85, z: 3.2, r: 0.45, ax: 0.2, ay: 0.6, sx: -0.00013, sy: -0.00017, a: 0.20 },
  ];
  const STAR_COLORS = ['255,255,255', '244,233,210', '201,174,123', '190,222,208'];

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight; F = Math.min(W, H) * 0.9;
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(900, Math.round(W * H / 1700));
    stars = Array.from({ length: n }, () => newStar(Math.random() * 3 + 0.2));
  }
  function newStar(z) {
    return { x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z,
             c: STAR_COLORS[Math.random() * STAR_COLORS.length | 0], tw: Math.random() * 6.28 };
  }
  const project = (x, y, z) => [W / 2 + (x - cam.x / z) / z * F, H / 2 + (y - cam.y / z) / z * F];

  function drawRing(g, t) {
    const rx = g.ax + t * g.sx, ry = g.ay + t * g.sy, N = 90;
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
    for (const [scale, alpha, width] of [[1, g.a, 1.4], [0.82, g.a * 0.45, 1]]) {
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const th = i / N * 6.2832;
        let x = Math.cos(th) * g.r * scale, y = Math.sin(th) * g.r * scale, z = 0;
        [y, z] = [y * cx - z * sx, y * sx + z * cx];          // tilt around x
        [x, z] = [x * cy + z * sy, -x * sy + z * cy];         // turn around y
        const [px, py] = project(g.x + x, g.y + y, g.z + z);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.strokeStyle = `rgba(201,174,123,${alpha})`; ctx.lineWidth = width; ctx.stroke();
    }
    const [px, py] = project(g.x, g.y, g.z), glow = ctx.createRadialGradient(px, py, 0, px, py, g.r / g.z * F * 0.5);
    glow.addColorStop(0, `rgba(201,174,123,${g.a * 0.35})`); glow.addColorStop(1, 'rgba(201,174,123,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(px, py, g.r / g.z * F * 0.5, 0, 6.2832); ctx.fill();
  }

  let last = performance.now();
  function frame(t) {
    const dt = Math.min(t - last, 50); last = t;
    cam.x += (mouse.x - cam.x) * 0.04; cam.y += (mouse.y - cam.y) * 0.04;
    ctx.clearRect(0, 0, W, H);
    for (const g of rings) drawRing(g, t);
    for (const s of stars) {
      if (!still) { s.z -= dt * 0.00004; if (s.z < 0.2) Object.assign(s, newStar(3.2)); }
      const [px, py] = project(s.x, s.y, s.z);
      if (px < -10 || px > W + 10 || py < -10 || py > H + 10) continue;
      const near = 1 - s.z / 3.2, size = 0.4 + near * 2.2;
      const alpha = Math.min(1, 0.15 + near * 1.5) * (0.75 + 0.25 * Math.sin(t * 0.002 + s.tw));
      ctx.fillStyle = `rgba(${s.c},${alpha})`;
      ctx.beginPath(); ctx.arc(px, py, size, 0, 6.2832); ctx.fill();
    }
    if (!still) requestAnimationFrame(frame);
  }

  addEventListener('resize', () => { resize(); if (still) frame(last); });
  addEventListener('mousemove', e => { mouse.x = (e.clientX / W - 0.5) * 0.6; mouse.y = (e.clientY / H - 0.5) * 0.6; });
  resize(); requestAnimationFrame(frame);
})();
  
