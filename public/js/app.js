/* ─────────────────────────────────────────────────────────
   Dream Mapper  -  app.js
   Starfield · auth · voice capture · save flow · fallback art
   ───────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ═══ 1. Starfield ════════════════════════════════════════ */

(function starfield() {
  const canvas = $("stars");
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
      tw: 0.4 + Math.random() * 2.4,          // twinkle speed
      ph: Math.random() * Math.PI * 2,        // phase offset
      warm: Math.random() < 0.16,             // a few peach-toned stars
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
      ctx.arc(s.x, s.y, s.r, 0, 7);
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

/* ═══ 2. API helper ════════════════════════════════════════ */

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new Error("Could not reach the server. Check that the Worker is running.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ═══ 3. Auth ══════════════════════════════════════════════ */

let currentUser = null;

function setUser(user) {
  currentUser = user;
  $("authArea").classList.toggle("hidden", !!user);
  $("userArea").classList.toggle("hidden", !user);
  $("authPrompt").classList.toggle("hidden", !!user);
  if (user) $("userHello").textContent = "☾ " + user.email.split("@")[0];
}

function openAuth(tab = "login") {
  window.location.href = tab === "register" ? "register.html" : "login.html";
}

$("loginBtn").addEventListener("click", () => openAuth("login"));
$("registerBtn").addEventListener("click", () => openAuth("register"));

/* Auth forms live on login.html / register.html (auth.js). */

$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  setUser(null);
  setStatus("Signed out. Your dreams are safe.");
});

async function checkAuth() {
  try {
    const data = await api("/api/auth/me");
    setUser(data.user || null);
  } catch {
    setUser(null);
  }
}

/* ═══ 4. Voice input (Web Speech API) ══════════════════════ */

const dreamText = $("dreamText");
const micBtn = $("micBtn");
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null, listening = false, baseText = "";

if (SpeechRec) {
  micBtn.hidden = false; // only show the mic if the browser supports it
  recognition = new SpeechRec();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        const clean = t.trim();
        if (clean) baseText += (baseText && !baseText.endsWith(" ") ? " " : "") + clean + " ";
      } else {
        interim += t;
      }
    }
    dreamText.value = (baseText + interim).slice(0, 4000);
    updateCount();
  };

  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    micBtn.setAttribute("aria-label", "Speak your dream");
    baseText = dreamText.value;
  };

  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed")
      setStatus("Microphone access was blocked  -  you can still type your dream.", true);
    else if (e.error === "no-speech")
      setStatus("I didn't catch that  -  tap the mic and try again.", true);
  };

  micBtn.addEventListener("click", () => {
    if (listening) { recognition.stop(); return; }
    baseText = dreamText.value;
    listening = true;
    micBtn.classList.add("listening");
    micBtn.setAttribute("aria-label", "Stop recording");
    try { recognition.start(); } catch { listening = false; micBtn.classList.remove("listening"); }
  });
}

/* ═══ 5. Counter, date, status ═════════════════════════════ */

function updateCount() {
  $("charCount").textContent = `${dreamText.value.length} / 4000`;
}
dreamText.addEventListener("input", updateCount);

// default the date to today
(function defaultDate() {
  const now = new Date();
  $("dreamDate").value = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
})();

function setStatus(msg, isError = false) {
  const el = $("statusArea");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

/* ═══ 6. Save flow ═════════════════════════════════════════ */

const saveBtn = $("saveBtn");
saveBtn.addEventListener("click", saveDream);

async function saveDream() {
  const text = dreamText.value.trim();

  if (text.length < 20)
    return setStatus("Your dream needs at least 20 characters  -  even a fragment counts.", true);
  if (text.length > 4000)
    return setStatus("That's longer than a dream can be  -  4,000 characters max.", true);

  if (!currentUser) {
    setStatus("Sign in first  -  your dream will still be here when you get back.", true);
    openAuth("login");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  setStatus("Analyzing your dream…");
  const paintTimer = setTimeout(() => setStatus("Painting it…"), 2600);

  try {
    const entry = await api("/api/dreams", {
      method: "POST",
      body: { text, dreamDate: $("dreamDate").value },
    });
    clearTimeout(paintTimer);
    showPreview(entry);
    setStatus(entry.title ? `Saved  -  “${entry.title}”` : "Saved.");
    dreamText.value = "";
    updateCount();
  } catch (err) {
    clearTimeout(paintTimer);
    setStatus(err.message, true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save dream";
  }
}

/* ═══ 7. Preview + fallback art ═════════════════════ */

// inject preview styles here instead of touching the stylesheet
const previewCSS = document.createElement("style");
previewCSS.textContent = `
  .dream-preview { margin-top: 18px; display: none; }
  .dream-preview.show { display: block; }
  .dream-preview img, .dream-preview canvas {
    width: 100%; display: block; border-radius: 14px;
    border: 1px solid rgba(255,255,255,0.09);
  }
  .dream-preview.waking img, .dream-preview.waking canvas {
    animation: wake 1.8s ease-out both;
  }
  @keyframes wake {
    from { filter: blur(24px); opacity: 0; transform: scale(1.04); }
    to   { filter: blur(0);   opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dream-preview.waking img, .dream-preview.waking canvas { animation: none; }
  }
`;
document.head.appendChild(previewCSS);

let previewWrap = null;
function ensurePreviewWrap() {
  if (!previewWrap) {
    previewWrap = document.createElement("div");
    previewWrap.className = "dream-preview";
    saveBtn.after(previewWrap);
  }
  return previewWrap;
}

function showPreview(entry) {
  let el;
  if (entry.imageFile) {
    el = new Image();
    el.alt = `${entry.title || "Dream"}  -  ${entry.summary || ""}`;
    el.src = `/images/${entry.imageFile}`;
  } else {
    el = paintFallback(entry.artSeed ?? 0, entry.mood ?? 0);
  }
  const wrap = ensurePreviewWrap();
  wrap.innerHTML = "";
  wrap.appendChild(el);
  wrap.classList.add("show");
  if (!reducedMotion) { // little wake-up animation
    wrap.classList.remove("waking");
    void wrap.offsetWidth;
    wrap.classList.add("waking");
  }
}

// Deterministic seeded RNG
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Canvas-generated dream art, seeded by the dream's mood and symbols
function paintFallback(seed, mood) {
  const S = 640;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  const rnd = mulberry32((seed * 2654435761 + 12345) | 0);

  const palette = mood < -0.3
    ? ["#1a0b2e", "#3d0f2f", "#8f2d4a", "#c46a4a"]   // nightmare: bruised reds
    : mood > 0.3
      ? ["#0e1b3d", "#1f5a6e", "#ffc7a8", "#a9f0d4"] // joyful: peach + mint
      : ["#0d0a24", "#2b1f5e", "#5b3a8f", "#ffc7a8"]; // neutral twilight

  const sky = x.createLinearGradient(0, 0, 0, S);
  sky.addColorStop(0, palette[0]);
  sky.addColorStop(1, palette[1]);
  x.fillStyle = sky;
  x.fillRect(0, 0, S, S);

  // soft glowing blobs
  for (let i = 0; i < 9; i++) {
    const cx = rnd() * S, cy = rnd() * S, r = 70 + rnd() * 190;
    const col = palette[2 + Math.floor(rnd() * 2)];
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, col + "55");
    g.addColorStop(1, col + "00");
    x.fillStyle = g;
    x.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // a moon
  const mx = S * (0.2 + rnd() * 0.6), my = S * (0.12 + rnd() * 0.3), mr = 16 + rnd() * 26;
  const mg = x.createRadialGradient(mx, my, 0, mx, my, mr * 3);
  mg.addColorStop(0, "#fff7ec");
  mg.addColorStop(0.12, "#ffe9d0aa");
  mg.addColorStop(1, "#ffe9d000");
  x.fillStyle = mg;
  x.beginPath();
  x.arc(mx, my, mr * 3, 0, 7);
  x.fill();

  // grain
  x.globalAlpha = 0.06;
  for (let i = 0; i < 2600; i++) {
    x.fillStyle = rnd() < 0.5 ? "#fff" : "#000";
    x.fillRect(rnd() * S, rnd() * S, 1, 1);
  }
  x.globalAlpha = 1;
  return c;
}

/* ═══ 8. Init ═══════════════════════════════════════════════ */

updateCount();
checkAuth();