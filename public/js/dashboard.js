/* ─────────────────────────────────────────────────────────
   Dream Mapper  -  dashboard.js
   Session guard · stats · chart · calendar · cards · edit · relive
   ───────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const RELIVE_MAX_MS = 5 * 60 * 60 * 1000;   // "up to 5 hours"

const state = {
  user: null,
  settings: null,
  dreams: [],
  filter: "all",
  range: "month",
  editing: null,
  reliving: null,
  pollTimer: null,
  tickTimer: null,
};

/* ═══ API ═════════════════════════════════════════════════ */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

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
    throw new ApiError("Could not reach the server. Check that the Worker is running.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

/* ═══ Utils ═══════════════════════════════════════════════ */

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function parseDay(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

const fmtDate = (iso) =>
  iso ? parseDay(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

function relTime(ts) {
  if (!ts) return "";
  const ms = Date.now() - Date.parse(ts);
  if (Number.isNaN(ms)) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? "s" : ""} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

const moodName = (mood = 0) => (mood < -0.3 ? "uneasy" : mood > 0.3 ? "joyful" : "twilight");

let statusTimer;
function setStatus(msg, isError = false) {
  const el = $("statusArea");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("error", isError);
  clearTimeout(statusTimer);
  if (!isError && msg) statusTimer = setTimeout(() => { el.textContent = ""; }, 5000);
}

/* seeded RNG  -  mirrors the Worker's, for card paintings */
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ═══ Auth guard ══════════════════════════════════════════ */

async function guard() {
  try {
    const data = await api("/api/auth/me");
    if (!data.user) return bounce();
    state.user = data.user;
    greet(data.user);
    return true;
  } catch {
    return bounce();
  }
}

function bounce() {
  // replace() keeps the dashboard out of history
  location.replace("/login.html?next=" + encodeURIComponent("/dashboard.html"));
  return false;
}

function greet(user) {
  const name = (state.settings && state.settings.display_name) || user.email.split("@")[0];
  $("welcomeName").textContent = name;
  $("logoutBtn").classList.remove("hidden");
  const avatar = $("userAvatar");
  if (avatar) {
    avatar.title = user.email;
    if (state.settings && state.settings.avatar_key) {
      avatar.textContent = "";
      avatar.style.backgroundImage = `url('/images/${state.settings.avatar_key}')`;
      avatar.style.backgroundSize = "cover";
      avatar.style.backgroundPosition = "center";
    } else {
      avatar.style.backgroundImage = "";
      avatar.textContent = name.slice(0, 1).toUpperCase();
    }
  }
}

$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  location.replace("/login.html");
});

/* ═══ Load dreams ═════════════════════════════════════════ */

async function loadDreams({ quiet = false } = {}) {
  try {
    const data = await api("/api/dreams");
    state.dreams = Array.isArray(data.dreams) ? data.dreams : [];
  } catch (err) {
    if (err.status === 401) return bounce();
    state.dreams = [];
    if (!quiet) setStatus(err.message, true);
    else console.warn("Could not load dreams:", err.message);
  }
  renderAll();
}

function renderAll() {
  renderStats();
  renderChart();
  renderCalendar();
  renderRecent();
  renderGrid();
  renderQueue();
  startTicker();
  schedulePoll();
}

/* ═══ Stats ═══════════════════════════════════════════════ */

function streakOf(dates) {
  const set = new Set(dates);
  let streak = 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (!set.has(ymd(d))) d.setDate(d.getDate() - 1);   // today may still be empty
  while (set.has(ymd(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

function renderStats() {
  const dreams = state.dreams;
  const total = dreams.length;
  const dates = [...new Set(dreams.map((d) => d.dreamDate).filter(Boolean))];

  // this week vs last week
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
  const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(now.getDate() - 14);
  const inRange = (iso, from, to) => { const t = parseDay(iso).getTime(); return t >= from && t <= to; };
  const thisWeek = dreams.filter((d) => inRange(d.dreamDate, weekAgo.getTime(), now.getTime())).length;
  const lastWeek = dreams.filter((d) => inRange(d.dreamDate, twoWeeksAgo.getTime(), weekAgo.getTime() - 1)).length;
  const diff = thisWeek - lastWeek;

  $("statCount").textContent = total;
  const delta = $("statDelta");
  delta.textContent = diff >= 0 ? `+${diff}` : String(diff);
  delta.classList.toggle("down", diff < 0);

  const streak = streakOf(dates);
  const latest = dreams[0];
  $("statSub").textContent = total === 0
    ? "Nothing here yet  -  last night is a good start."
    : streak > 0
      ? `${streak}-night streak · last ${fmtDate(latest.dreamDate)}`
      : `Last dream ${fmtDate(latest.dreamDate)}`;

  // average over the selected range
  const days = state.range === "week" ? 7 : state.range === "year" ? 365 : 30;
  const from = now.getTime() - (days - 1) * 86_400_000;
  const inWindow = dreams.filter((d) => inRange(d.dreamDate, from, now.getTime()));
  const avg = inWindow.length / days;
  const rangeWord = days === 7 ? "week" : days === 365 ? "year" : "month";
  $("avgLine").textContent = total === 0
    ? "Average  -  0 dreams a night"
    : `Average  -  ${avg.toFixed(1)} dreams a night · ${inWindow.length} in the last ${rangeWord}`;

  // vivid share, last 30 nights
  const from30 = now.getTime() - 29 * 86_400_000;
  const w30 = dreams.filter((d) => inRange(d.dreamDate, from30, now.getTime()));
  const vivid30 = w30.filter((d) => d.vivid).length;
  const share = w30.length ? Math.round((vivid30 / w30.length) * 100) : 0;
  $("statVivid").textContent = vivid30;
  $("vividDelta").textContent = `${share}%`;
  $("vividBar").style.width = `${share}%`;
  $("vividFoot").textContent = w30.length ? `${vivid30} of ${w30.length} dreams` : "no dreams yet";

  // most seen symbol
  const freq = {};
  for (const d of dreams) for (const s of d.symbols || []) freq[s] = (freq[s] || 0) + 1;
  const ranked = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  $("statSymbol").textContent = top ? top[0][0].toUpperCase() + top[0].slice(1) : " - ";
  $("symbolDelta").textContent = top && total ? `${Math.round((top[1] / total) * 100)}%` : "0%";
  $("symbolBars").innerHTML = ranked.slice(0, 4).map(([, n]) => {
    const h = Math.round((n / (ranked[0][1] || 1)) * 100);
    return `<span style="height:${Math.max(15, h)}%"></span>`;
  }).join("");
}

/* ═══ Rhythm chart ════════════════════════════════════════ */

function renderChart() {
  const svg = $("rhythmChart");
  const labels = $("chartLabels");
  const now = new Date(); now.setHours(0, 0, 0, 0);

  let buckets = [];
  if (state.range === "week") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      buckets.push({ key: ymd(d), label: d.toLocaleDateString(undefined, { weekday: "short" }) });
    }
  } else if (state.range === "month") {
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      buckets.push({ key: ymd(d), label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) });
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
                     label: d.toLocaleDateString(undefined, { month: "short" }) });
    }
  }

  const byKey = {};
  for (const d of state.dreams) {
    const k = state.range === "year" ? String(d.dreamDate || "").slice(0, 7) : d.dreamDate;
    if (!k) continue;
    (byKey[k] ||= { count: 0, vivid: 0 });
    byKey[k].count++;
    if (d.vivid) byKey[k].vivid++;
  }

  const counts = buckets.map((b) => byKey[b.key]?.count || 0);
  const vivid = buckets.map((b) => byKey[b.key]?.vivid || 0);
  const max = Math.max(1, ...counts);

  const W = 320, top = 12, base = 140;
  const slot = (W - 4) / buckets.length;
  const barW = Math.max(3, Math.min(18, slot * 0.55));

  let bars = "";
  buckets.forEach((b, i) => {
    const h = (counts[i] / max) * (base - top);
    const x = 2 + i * slot + (slot - barW) / 2;
    if (counts[i]) {
      const y = base - h;
      bars += `<rect class="chart-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}"
        height="${h.toFixed(1)}" rx="3" fill="#8b7bff" opacity="0.9"><title>${b.label} · ${counts[i]}
        dream${counts[i] > 1 ? "s" : ""}${vivid[i] ? ` · ${vivid[i]} vivid` : ""}</title></rect>`;
    } else {
      bars += `<rect x="${x.toFixed(1)}" y="${base - 1}" width="${barW.toFixed(1)}" height="1"
        fill="rgba(255,255,255,0.12)"/>`;
    }
  });

  const pts = vivid
    .map((v, i) => `${(2 + i * slot + slot / 2).toFixed(1)},${(base - (v / max) * (base - top)).toFixed(1)}`)
    .join(" ");
  const line = vivid.some((v) => v > 0)
    ? `<polyline class="chart-line" points="${pts}" fill="none" stroke="#a9f0d4"
        stroke-width="1.5" stroke-linejoin="round" opacity="0.9"/>`
    : "";

  const grid = [0.25, 0.5, 0.75].map((f) => {
    const y = (base - f * (base - top)).toFixed(1);
    return `<line x1="2" x2="${W - 2}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,0.07)"/>`;
  }).join("");

  svg.innerHTML = grid + bars + line;
  labels.innerHTML = `<span>${buckets[0].label}</span><span>${buckets[buckets.length - 1].label}</span>`;
}

/* ═══ Calendar (heatmap replacement) ══════════════════════ */

function renderCalendar() {
  const grid = $("calGrid");
  const monthsEl = $("calMonths");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayKey = ymd(today);

  const perDay = {};
  for (const d of state.dreams) {
    if (!d.dreamDate) continue;
    (perDay[d.dreamDate] ||= { count: 0, vivid: false });
    perDay[d.dreamDate].count++;
    if (d.vivid) perDay[d.dreamDate].vivid = true;
  }

  const WEEKS = 18;                                   // ~4 months of columns
  const start = new Date(today);
  const dow = (start.getDay() + 6) % 7;               // Mon = 0
  start.setDate(start.getDate() - dow - (WEEKS - 1) * 7);

  let html = "";
  const monthSpans = [];
  let lastMonth = -1;

  for (let w = 0; w < WEEKS; w++) {
    for (let r = 0; r < 7; r++) {                     // rows: Mon → Sun
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + r);
      const key = ymd(day);
      const future = day > today;
      const info = perDay[key];
      const level = !info ? 0 : info.count >= 4 ? 4 : info.count;
      const isToday = key === todayKey;

      if (r === 0 && day.getMonth() !== lastMonth) {
        lastMonth = day.getMonth();
        monthSpans.push({ col: w + 1, label: day.toLocaleDateString(undefined, { month: "short" }) });
      }

      const title = future ? "" :
        day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
        (info ? ` · ${info.count} dream${info.count > 1 ? "s" : ""}${info.vivid ? " · vivid" : ""}` : " · no dream");

      html += `<div class="cal-cell${isToday ? " today" : ""}${future ? " cal-future" : ""}"
        data-level="${future ? 0 : level}"${info && info.vivid && !future ? ' data-vivid="true"' : ""}
        title="${esc(title)}"></div>`;
    }
  }

  grid.innerHTML = html;
  monthsEl.style.gridTemplateColumns = `repeat(${WEEKS}, minmax(0, 1fr))`;
  monthsEl.innerHTML = monthSpans.map((m) => `<span style="grid-column:${m.col}">${m.label}</span>`).join("");
}

/* ═══ Recent list ═════════════════════════════════════════ */

function renderRecent() {
  const list = $("recentList");
  const empty = $("recentEmpty");
  const latest = [...state.dreams]
    .sort((a, b) => String(b.dreamDate || "").localeCompare(String(a.dreamDate || "")))
    .slice(0, 5);

  list.innerHTML = latest.map((d) => {
    const moodClass = d.mood < -0.3 ? "uneasy" : d.mood > 0.3 ? "joyful" : "twilight";
    return `<li>
      <span class="mood-dot ${moodClass}" aria-hidden="true"></span>
      <span class="recent-text">
        <span class="recent-title">${esc(d.title)}</span>
        <span class="recent-meta">${fmtDate(d.dreamDate)}${d.vivid ? ' · <em class="vivid-tag">vivid</em>' : ""}</span>
      </span>
    </li>`;
  }).join("");

  list.classList.toggle("hidden", latest.length === 0);
  empty.classList.toggle("hidden", latest.length > 0);
}

/* ═══ Explorer grid ═══════════════════════════════════════ */

function filteredDreams() {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const weekAgo = now.getTime() - 6 * 86_400_000;
  return state.dreams
    .filter((d) => {
      if (state.filter === "vivid") return d.vivid;
      if (state.filter === "week") return d.dreamDate && parseDay(d.dreamDate).getTime() >= weekAgo;
      return true;
    })
    .sort((a, b) => String(b.dreamDate || "").localeCompare(String(a.dreamDate || "")));
}

function renderGrid() {
  const grid = $("dreamGrid");
  const list = filteredDreams();

  grid.innerHTML = list.map(cardHTML).join("");
  grid.querySelectorAll("canvas[data-seed]").forEach((c) => {
    paintArt(c, Number(c.dataset.seed), Number(c.dataset.mood));
  });

  $("emptyState").classList.toggle("hidden", list.length > 0);
}

function cardHTML(d) {
  const moodClass = d.mood < -0.3 ? "uneasy" : d.mood > 0.3 ? "joyful" : "twilight";
  const art = d.imageFile
    ? `<img class="dream-art" src="/images/${esc(d.imageFile)}" alt="${esc(d.title)}" loading="lazy" />`
    : `<canvas class="dream-art" width="640" height="360" data-seed="${d.artSeed}" data-mood="${d.mood}" aria-hidden="true"></canvas>`;
  return `
  <article class="dream-card" data-id="${d.id}">
    <div class="dream-art-wrap">
      ${art}
      ${d.vivid ? '<span class="vivid-badge">vivid</span>' : ""}
    </div>
    <div class="dream-body">
      <div class="dream-top">
        <h3 class="dream-title">${esc(d.title)}</h3>
        <span class="dream-when">${fmtDate(d.dreamDate)}</span>
      </div>
      <p class="dream-summary">${esc(d.summary || "")}</p>
      <div class="chips">
        <span class="chip mood">${moodName(d.mood)}</span>
        ${(d.symbols || []).slice(0, 3).map((s) => `<span class="chip">${esc(s)}</span>`).join("")}
        ${!(d.symbols || []).length ? '<span class="chip">no symbols</span>' : ""}
      </div>
      ${reliveStripHTML(d)}
      <div class="card-actions">
        <button class="btn ghost small" type="button" data-act="edit">Change details</button>
        <button class="btn solid small" type="button" data-act="relive"
          ${d.vivid ? "" : 'disabled title="Only vivid dreams can be relived"'}>Relive</button>
      </div>
    </div>
  </article>`;
}

/* deterministic painting from artSeed  -  no images needed */
function paintArt(canvas, seed, mood = 0) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  const rnd = mulberry32((seed >>> 0) || 1);

  const warm = mood > 0.15, cold = mood < -0.15;
  const hues = warm ? [18, 38, 320] : cold ? [222, 248, 205] : [258, 278, 292];

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, `hsl(${hues[0]}, ${cold ? 40 : 45}%, ${cold ? 9 : 13}%)`);
  bg.addColorStop(1, `hsl(${hues[1]}, 50%, 5%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const orbs = 6 + Math.floor(rnd() * 5);
  for (let i = 0; i < orbs; i++) {
    const x = rnd() * w, y = rnd() * h;
    const r = (0.1 + rnd() * 0.28) * Math.min(w, h);
    const hue = hues[Math.floor(rnd() * hues.length)] + (rnd() * 24 - 12);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `hsla(${hue}, 75%, 65%, ${(0.22 + rnd() * 0.2).toFixed(2)})`);
    g.addColorStop(1, "hsla(0, 0%, 0%, 0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  const mx = w * (0.62 + rnd() * 0.3), my = h * (0.12 + rnd() * 0.2);
  const mr = Math.min(w, h) * (0.05 + rnd() * 0.04);
  const moon = ctx.createRadialGradient(mx, my, 0, mx, my, mr * 3);
  moon.addColorStop(0, "rgba(255, 244, 224, 0.95)");
  moon.addColorStop(0.25, "rgba(255, 236, 200, 0.35)");
  moon.addColorStop(1, "rgba(255, 236, 200, 0)");
  ctx.fillStyle = moon;
  ctx.beginPath(); ctx.arc(mx, my, mr * 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255, 246, 228, 0.95)";
  ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.8)";
  const stars = 30 + Math.floor(rnd() * 30);
  for (let i = 0; i < stars; i++) {
    ctx.globalAlpha = 0.15 + rnd() * 0.6;
    ctx.fillRect(rnd() * w, rnd() * h * 0.7, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;
}

/* ═══ Relive strips + queue ═══════════════════════════════ */

function etaText(ms) {
  if (ms <= 0) return "any moment";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  return h > 0 ? `~${h}h ${m}m left` : `~${m} min left`;
}

function reliveStripHTML(d) {
  const r = d.relive;
  if (!r) return "";

  if (r.status === "ready") {
    if (r.videoFile) {
      return `<div class="relive-strip">
        <video controls preload="metadata" src="${esc(r.videoFile)}"></video>
        <p class="relive-meta">expires ${fmtDate(String(r.expiresAt || "").slice(0, 10))}</p>
      </div>`;
    }
    return `<div class="relive-strip">
      <p class="relive-meta">Render finished  -  video delivery coming soon.
      Kept until ${fmtDate(String(r.expiresAt || "").slice(0, 10))}.</p>
    </div>`;
  }

  if (r.status === "failed")
    return `<div class="relive-strip"><p class="relive-meta">Render failed  -  you can try again.</p></div>`;

  // queued / rendering → live progress bar
  const pct = Math.max(0, Math.min(100, r.progress || 0));
  const endsAt = Date.now() + (r.etaMs || 0);
  const duration = (r.etaMs || 0) / Math.max(1, 100 - pct) * 100;
  return `<div class="relive-strip relive-live" data-ends="${endsAt}" data-duration="${Math.round(duration)}">
    <div class="progress"><span class="fill" style="width:${pct}%"></span></div>
    <p class="relive-meta"><span class="pct">${Math.round(pct)}%</span> ·
      <span class="eta">${etaText(r.etaMs || 0)}</span></p>
  </div>`;
}

function renderQueue() {
  const queue = $("reliveQueue");
  const empty = $("reliveEmpty");
  if (!queue || !empty) return;

  const jobs = state.dreams.filter((d) => d.relive && d.relive.status !== "failed");
  const active = jobs.filter((d) => d.relive.status === "queued" || d.relive.status === "rendering");
  const ready = jobs.filter((d) => d.relive.status === "ready");

  queue.innerHTML = [
    ...active.map((d) => {
      const r = d.relive;
      const pct = Math.max(0, Math.min(100, r.progress || 0));
      const endsAt = Date.now() + (r.etaMs || 0);
      const duration = (r.etaMs || 0) / Math.max(1, 100 - pct) * 100;
      return `<div class="queue-item relive-live" data-ends="${endsAt}" data-duration="${Math.round(duration)}">
        <div class="queue-text">
          <p class="queue-title">${esc(d.title)}</p>
          <p class="relive-meta"><span class="pct">${Math.round(pct)}%</span> ·
            <span class="eta">${etaText(r.etaMs || 0)}</span> · rendering</p>
        </div>
        <div class="progress"><span class="fill" style="width:${pct}%"></span></div>
      </div>`;
    }),
    ...ready.slice(0, 3).map((d) => `
      <div class="queue-item done">
        <div class="queue-text">
          <p class="queue-title">${esc(d.title)}</p>
          <p class="relive-meta">ready${d.relive.expiresAt ? ` · expires ${fmtDate(d.relive.expiresAt.slice(0, 10))}` : ""}</p>
        </div>
        <span class="chip mint">✓</span>
      </div>`),
  ].join("");

  empty.classList.toggle("hidden", active.length > 0 || ready.length > 0);
}

/* progress bars count up live between polls; on expiry → reload */
function startTicker() {
  clearInterval(state.tickTimer);
  if (!document.querySelector(".relive-live")) return;

  state.tickTimer = setInterval(() => {
    let expired = false;
    document.querySelectorAll(".relive-live").forEach((el) => {
      const remain = Number(el.dataset.ends) - Date.now();
      const duration = Number(el.dataset.duration) || 1;
      if (remain <= 0) { expired = true; return; }
      const pct = Math.min(99.9, 100 - (remain / duration) * 100);
      const fill = el.querySelector(".fill");
      if (fill) fill.style.width = `${pct.toFixed(1)}%`;
      const eta = el.querySelector(".eta");
      if (eta) eta.textContent = etaText(remain);
      const pctEl = el.querySelector(".pct");
      if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    });
    if (expired) {
      clearInterval(state.tickTimer);
      loadDreams({ quiet: true });
    }
  }, 1000);
}

/* quiet re-fetch: fast while renders are running, slow otherwise */
function schedulePoll() {
  clearTimeout(state.pollTimer);
  const active = state.dreams.some((d) =>
    d.relive && (d.relive.status === "queued" || d.relive.status === "rendering"));
  state.pollTimer = setTimeout(() => loadDreams({ quiet: true }), active ? 60_000 : 300_000);
}

/* ═══ Log form ════════════════════════════════════════════ */

function initLogForm() {
  const text = $("dreamText"), date = $("dreamDate");
  const count = $("charCount"), save = $("saveBtn");
  const today = ymd(new Date());
  date.value = today;
  date.max = today;

  const sync = () => {
    const len = text.value.trim().length;
    count.textContent = `${text.value.length} / 4000`;
    save.disabled = len < 20 || len > 4000;
  };
  text.addEventListener("input", sync);
  sync();

  save.addEventListener("click", async () => {
    const body = { text: text.value.trim(), dreamDate: date.value || today };
    save.disabled = true;
    try {
      const d = await api("/api/dreams", { method: "POST", body });
      state.dreams.unshift(d);
      state.dreams.sort((a, b) => String(b.dreamDate || "").localeCompare(String(a.dreamDate || "")));
      text.value = "";
      sync();
      renderAll();
      setStatus(`Saved “${d.title}”  -  ${d.vivid ? "vivid enough to relive" : "logged for the map"}.`);
    } catch (err) {
      if (err.status === 401) return bounce();
      setStatus(err.message, true);
      save.disabled = false;
    }
  });
}

/* ═══ Edit modal (+ delete) ═══════════════════════════════ */

function openEdit(id) {
  const d = state.dreams.find((x) => x.id === id);
  if (!d) return;
  state.editing = id;
  $("editText").value = d.text;
  $("editDate").value = d.dreamDate || ymd(new Date());
  $("editDate").max = ymd(new Date());
  $("editError").textContent = "";
  $("editModal").showModal();
}

function initEditModal() {
  const modal = $("editModal");
  const form = $("editForm");
  const errEl = $("editError");

  // delete button added here so the markup stays clean
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn danger";
  delBtn.textContent = "Delete";
  form.querySelector(".modal-actions").prepend(delBtn);

  let armed = false;
  delBtn.addEventListener("click", async () => {
    if (!state.editing) return;
    if (!armed) {                                   // first click arms it
      armed = true;
      delBtn.textContent = "Really delete?";
      delBtn.classList.add("armed");
      setTimeout(() => {
        armed = false;
        delBtn.textContent = "Delete";
        delBtn.classList.remove("armed");
      }, 3500);
      return;
    }
    armed = false;
    const id = state.editing;
    try {
      await api(`/api/dreams/${id}`, { method: "DELETE" });
      state.dreams = state.dreams.filter((d) => d.id !== id);
      modal.close();
      state.editing = null;
      renderAll();
      setStatus("Dream deleted.");
    } catch (err) {
      if (err.status === 401) return bounce();
      errEl.textContent = err.message;
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.editing) return;
    errEl.textContent = "";
    const body = { text: $("editText").value.trim(), dreamDate: $("editDate").value };
    if (body.text.length < 20) {
      errEl.textContent = "A dream needs at least 20 characters.";
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const data = await api(`/api/dreams/${state.editing}`, { method: "PUT", body });
      const idx = state.dreams.findIndex((d) => d.id === state.editing);
      if (idx >= 0) state.dreams[idx] = data.dream;
      modal.close();
      state.editing = null;
      renderAll();
      setStatus("Details updated.");
    } catch (err) {
      if (err.status === 401) return bounce();
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  const close = () => { modal.close(); state.editing = null; };
  $("editCloseBtn").addEventListener("click", close);
  $("editCancelBtn").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
}

/* ═══ Relive modal ════════════════════════════════════════ */

function openRelive(id) {
  const d = state.dreams.find((x) => x.id === id);
  if (!d || !d.vivid) return;
  if (d.relive && (d.relive.status === "queued" || d.relive.status === "rendering")) {
    setStatus("This dream is already being relived.", true);
    return;
  }
  state.reliving = id;
  $("reliveSub").textContent = `“${d.title}” · ${fmtDate(d.dreamDate)}`;
  $("reliveModal").showModal();
}

function initReliveModal() {
  const modal = $("reliveModal");
  const close = () => { modal.close(); state.reliving = null; };
  $("reliveCloseBtn").addEventListener("click", close);
  $("reliveCancelBtn").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  $("reliveConfirmBtn").addEventListener("click", async () => {
    const id = state.reliving;
    if (!id) return close();
    const btn = $("reliveConfirmBtn");
    btn.disabled = true;
    try {
      const data = await api(`/api/dreams/${id}/relive`, { method: "POST" });
      const d = state.dreams.find((x) => x.id === id);
      if (d) d.relive = data.relive;
      close();
      renderAll();
      setStatus("Relive started  -  it can take up to 5 hours. Watch the Relive panel.");
    } catch (err) {
      if (err.status === 401) return bounce();
      close();
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ═══ Controls ════════════════════════════════════════════ */

function initControls() {
  document.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter").forEach((b) => b.classList.toggle("active", b === btn));
      state.filter = btn.dataset.filter;
      renderGrid();
    });
  });

  document.querySelectorAll("[data-range]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-range]").forEach((b) => b.classList.toggle("active", b === btn));
      state.range = btn.dataset.range;
      renderStats();
      renderChart();
    });
  });

  $("refreshBtn").addEventListener("click", async () => {
    const btn = $("refreshBtn");
    btn.classList.add("spinning");
    await loadDreams();
    btn.classList.remove("spinning");
  });
}

function initGridActions() {
  $("dreamGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const card = btn.closest(".dream-card");
    if (!card) return;
    if (btn.dataset.act === "edit") openEdit(card.dataset.id);
    if (btn.dataset.act === "relive") openRelive(card.dataset.id);
  });
}

function initNav() {
  const links = [...document.querySelectorAll(".pill-nav a")];
  const sections = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
  if (!sections.length || reducedMotion) return;
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${en.target.id}`));
    }
  }, { rootMargin: "-40% 0px -55% 0px" });
  sections.forEach((s) => io.observe(s));
}

/* ═══ Chat ════════════════════════════════════════════════ */

let chatDreamId = null;

function renderChat(messages) {
  const log = $("chatLog");
  if (!log) return;
  log.innerHTML = (messages || []).map((m) => {
    const cls = m.role === "reply" ? "chat-msg reply" : "chat-msg user";
    return `<div class="${cls}"><p>${esc(m.content)}</p><span class="chat-time">${relTime(m.created_at)}</span></div>`;
  }).join("");
  log.scrollTop = log.scrollHeight;
}

async function loadChat() {
  try {
    const data = await api("/api/chat" + (chatDreamId ? `?dreamId=${encodeURIComponent(chatDreamId)}` : ""));
    renderChat(data.messages || []);
  } catch (err) {
    if (err.status === 401) return bounce();
  }
}

async function loadSymbols() {
  const cloud = $("symbolCloud");
  if (!cloud) return;
  try {
    const data = await api("/api/symbols");
    const syms = data.symbols || [];
    cloud.innerHTML = syms.map((s) => `<span class="chip">${esc(s.symbol)} <em>${s.count}</em></span>`).join("");
  } catch (e) {}
}

async function sendChat() {
  const input = $("chatInput");
  const btn = $("chatSendBtn");
  const text = input.value.trim();
  if (!text) return;
  btn.disabled = true;
  const log = $("chatLog");
  // optimistic user bubble
  const temp = document.createElement("div");
  temp.className = "chat-msg user";
  temp.innerHTML = `<p>${esc(text)}</p>`;
  log.appendChild(temp);
  log.scrollTop = log.scrollHeight;
  input.value = "";
  try {
    const data = await api("/api/chat", { method: "POST", body: { dreamId: chatDreamId, message: text } });
    await loadChat();
    await loadSymbols();
    $("chatStatus").textContent = "";
  } catch (err) {
    if (err.status === 401) return bounce();
    $("chatStatus").textContent = err.message;
    $("chatStatus").classList.add("error");
  } finally {
    btn.disabled = false;
  }
}

function initChat() {
  const btn = $("chatSendBtn");
  const input = $("chatInput");
  if (!btn || !input) return;
  btn.addEventListener("click", sendChat);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
}

/* ═══ Settings ═══════════════════════════════════════════ */

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    state.settings = data.settings || null;
    if (state.settings) {
      if ($("settingsName")) $("settingsName").value = state.settings.display_name || "";
      if ($("settingsAi")) $("settingsAi").value = state.settings.style_instructions || "";
    }
    if (state.user) greet(state.user);
  } catch (e) {}
}

function initModals() {
  const openLog = () => $("logModal").showModal();
  $("logOpenBtn").addEventListener("click", openLog);
  const emptyBtn = $("emptyLogBtn");
  if (emptyBtn) emptyBtn.addEventListener("click", openLog);
  $("logCloseBtn").addEventListener("click", () => $("logModal").close());

  $("chatOpenBtn").addEventListener("click", () => $("chatModal").showModal());
  $("chatCloseBtn").addEventListener("click", () => $("chatModal").close());

  $("settingsOpenBtn").addEventListener("click", () => $("settingsModal").showModal());
  $("settingsCloseBtn").addEventListener("click", () => $("settingsModal").close());

  [["logModal"], ["chatModal"], ["settingsModal"]].forEach(([id]) => {
    const dlg = $(id);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  });
}

async function saveSettings() {
  const btn = $("settingsSaveBtn");
  btn.disabled = true;
  try {
    const file = $("avatarFile").files && $("avatarFile").files[0];
    if (file) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const up = await api("/api/avatar", { method: "POST", body: { image: dataUrl } });
      state.settings = { ...(state.settings || {}), avatar_key: up.avatarKey };
      greet(state.user);
    }
    await api("/api/settings", {
      method: "PUT",
      body: {
        displayName: $("settingsName").value.trim(),
        aiInstructions: $("settingsAi").value.trim(),
      },
    });
    await loadSettings();
    $("settingsStatus").textContent = "Settings saved.";
    $("settingsStatus").classList.remove("error");
  } catch (err) {
    if (err.status === 401) return bounce();
    $("settingsStatus").textContent = err.message;
    $("settingsStatus").classList.add("error");
  } finally {
    btn.disabled = false;
  }
}

async function exportData() {
  const btn = $("exportBtn");
  btn.disabled = true;
  try {
    const data = await api("/api/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dream-mapper-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    $("settingsStatus").textContent = "Export downloaded.";
    $("settingsStatus").classList.remove("error");
  } catch (err) {
    if (err.status === 401) return bounce();
    $("settingsStatus").textContent = err.message;
    $("settingsStatus").classList.add("error");
  } finally {
    btn.disabled = false;
  }
}

function initSettings() {
  const save = $("settingsSaveBtn");
  const exp = $("exportBtn");
  if (save) save.addEventListener("click", saveSettings);
  if (exp) exp.addEventListener("click", exportData);
}

/* ═══ Boot ════════════════════════════════════════════════ */

async function init() {
  initControls();
  initGridActions();
  initLogForm();
  initEditModal();
  initReliveModal();
  initChat();
  initSettings();
  initModals();
  initNav();

  const ok = await guard();
  if (!ok) return;                    // bounced to /login.html

  await loadSettings();
  await loadDreams();
  await loadChat();
  await loadSymbols();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadDreams({ quiet: true });
  });
}

init();
