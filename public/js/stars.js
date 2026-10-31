/* Dream Mapper - stars.js
   Shared starfield background used on every page. */
(function starfield() {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.getElementById("stars");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let stars = [], meteors = [], W = 0, H = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width = Math.floor(innerWidth * dpr);
    H = canvas.height = Math.floor(innerHeight * dpr);
    const count = Math.min(400, Math.round((W * H) / (3600 * dpr)));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: (0.4 + Math.random() * 1.5) * dpr,
      tw: 0.4 + Math.random() * 2.4,
      ph: Math.random() * Math.PI * 2,
      warm: Math.random() < 0.16,
    }));
    if (reducedMotion) draw(0);
  }

  function spawnMeteor() {
    meteors.push({
      x: Math.random() * W,
      y: -20,
      vx: (Math.random() < 0.5 ? 1 : -1) * (3 + Math.random() * 3),
      vy: 2.4 + Math.random() * 2,
      life: 1,
    });
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);

    for (const s of stars) {
      const a = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.001 * s.tw + s.ph));
      ctx.globalAlpha = a;
      ctx.fillStyle = s.warm ? "#ffd9b8" : "#eef0ff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!reducedMotion && Math.random() < 0.0025) spawnMeteor();
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      m.x += m.vx; m.y += m.vy; m.life -= 0.016;
      if (m.life <= 0 || m.y > H + 40) { meteors.splice(i, 1); continue; }
      const tail = 14;
      const g = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * tail, m.y - m.vy * tail);
      g.addColorStop(0, `rgba(255,240,220,${0.85 * m.life})`);
      g.addColorStop(1, "rgba(255,240,220,0)");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(m.x - m.vx * tail, m.y - m.vy * tail);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (!reducedMotion) requestAnimationFrame(draw);
  }

  let rt;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
  resize();
  if (!reducedMotion) requestAnimationFrame(draw);
})();
