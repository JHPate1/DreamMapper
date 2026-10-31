/* Dream Mapper - Cloudflare Worker
   Auth, dreams, image generation, R2 storage, relive jobs. */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, ctx, url);
      }
      if (url.pathname.startsWith("/images/")) {
        return await serveImage(request, env, url);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: err && err.message ? err.message : "Server error" }, 500);
    }
  },
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function isSecure(request) {
  try { return new URL(request.url).protocol === "https:"; } catch { return true; }
}

function sessionCookie(token, secure = true) {
  return `session=${token}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}

function clearCookie(secure = true) {
  return `session=; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=0`;
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return `pbkdf2$100000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = fromB64(parts[2]);
  const expected = parts[3];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return timingSafeEqual(b64(new Uint8Array(bits)), expected);
}

async function getSessionUser(env, request) {
  const token = getCookie(request, "session");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT users.id AS id, users.email AS email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.expires_at > ?"
  )
    .bind(token, new Date().toISOString())
    .first();
  return row ? { id: row.id, email: row.email } : null;
}

async function createSession(env, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)")
    .bind(token, userId, now.toISOString(), expires.toISOString())
    .run();
  return token;
}

const IMAGE_URL = "https://ai.hackclub.com/proxy/v1/chat/completions";

function imageKey(env) {
  return env && env.IMAGE_API_KEY ? env.IMAGE_API_KEY : "";
}

async function imageChat(env, { model, messages, modalities, imageConfig } = {}) {
  const body = { model, messages: messages || [] };
  if (modalities) body.modalities = modalities;
  if (imageConfig) body.image_config = imageConfig;
  const res = await fetch(IMAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${imageKey(env)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image request failed (${res.status}) ${text.slice(0, 120)}`);
  }
  return res.json();
}

function findImageSource(obj) {
  function walk(o) {
    if (o == null) return null;
    if (typeof o === "string") {
      if (o.startsWith("data:image")) {
        const m = o.match(/^data:image\/[^;]+;base64,(.+)$/);
        if (m) return { type: "base64", data: m[1] };
      }
      if (/^https?:\/\//.test(o) && /\.(png|jpg|jpeg|webp)(\?|$)/i.test(o)) {
        return { type: "url", url: o };
      }
      if (o.length > 500 && /^[A-Za-z0-9+/=\r\n]+$/.test(o)) {
        return { type: "base64", data: o.replace(/\s+/g, "") };
      }
      return null;
    }
    if (Array.isArray(o)) {
      for (const item of o) {
        const r = walk(item);
        if (r) return r;
      }
      return null;
    }
    if (typeof o === "object") {
      for (const k in o) {
        const r = walk(o[k]);
        if (r) return r;
      }
    }
    return null;
  }
  return walk(obj);
}

async function imageSourceToBytes(env, src) {
  if (src.type === "base64") {
    return fromB64(src.data).buffer;
  }
  if (src.type === "url") {
    const res = await fetch(src.url);
    if (!res.ok) throw new Error("image fetch failed");
    return await res.arrayBuffer();
  }
  return null;
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function moodName(mood = 0) {
  return mood < -0.3 ? "uneasy" : mood > 0.3 ? "joyful" : "twilight";
}

function makeTitle(text) {
  const first = String(text || "").trim().split(/[.!?]/)[0] || text;
  const words = first.trim().split(/\s+/).slice(0, 6).join(" ");
  if (!words) return "Untitled dream";
  return words.length > 70 ? words.slice(0, 70) + "..." : words;
}

function heuristicMood(text) {
  const t = String(text || "").toLowerCase();
  const bad = ["nightmare", "fear", "scared", "dark", "blood", "chase", "falling", "lost", "dead", "alone", "anxious"];
  const good = ["happy", "joy", "flying", "love", "bright", "sun", "garden", "friend", "laugh", "calm", "peace"];
  let score = 0;
  for (const w of bad) if (t.includes(w)) score -= 0.22;
  for (const w of good) if (t.includes(w)) score += 0.22;
  return Math.max(-1, Math.min(1, score));
}

function heuristicSymbols(text) {
  const candidates = [
    "water", "school", "house", "forest", "sky", "moon", "mother", "father", "friend", "animal",
    "door", "road", "car", "child", "baby", "fire", "ocean", "mountain", "city", "garden",
    "mirror", "snake", "bird", "cat", "dog", "teeth", "flying", "falling", "rain", "stars",
  ];
  const t = String(text || "").toLowerCase();
  return candidates.filter((c) => t.includes(c)).slice(0, 6);
}

function heuristicVivid(text) {
  const t = String(text || "");
  return t.length > 320 || /vivid|lucid|intense|clear|real/i.test(t);
}

async function upsertSymbols(env, userId, symbols) {
  if (!env || !env.DB || !userId) return;
  const list = (symbols || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  for (const sym of list) {
    const existing = await env.DB.prepare("SELECT id, count FROM symbols WHERE user_id = ? AND symbol = ?")
      .bind(userId, sym)
      .first();
    if (existing) {
      await env.DB.prepare("UPDATE symbols SET count = ?, updated_at = ? WHERE id = ?")
        .bind((existing.count || 0) + 1, new Date().toISOString(), existing.id)
        .run();
    } else {
      await env.DB.prepare("INSERT INTO symbols (id, user_id, symbol, count, updated_at) VALUES (?,?,?,?,?)")
        .bind(crypto.randomUUID(), userId, sym, 1, new Date().toISOString())
        .run();
    }
  }
}

async function analyzeDream(env, text) {
  const base = {
    title: makeTitle(text),
    summary: String(text).replace(/\s+/g, " ").trim().slice(0, 180),
    mood: heuristicMood(text),
    symbols: heuristicSymbols(text),
    vivid: heuristicVivid(text),
    artSeed: hash32(text),
  };

  try {
    const out = await imageChat(env, {
      model: "openai/gpt-oss-20b",
      messages: [
        {
          role: "system",
          content:
            "You analyze a dream and return ONLY compact JSON with keys: title (short phrase), summary (one sentence), mood (number from -1 to 1), symbols (array of up to 6 lowercase nouns), vivid (boolean). No markdown.",
        },
        { role: "user", content: String(text).slice(0, 4000) },
      ],
    });
    const raw = out && out.choices && out.choices[0] && out.choices[0].message ? out.choices[0].message.content : "";
    const match = String(raw).match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.title) base.title = String(parsed.title).slice(0, 80);
      if (parsed.summary) base.summary = String(parsed.summary).slice(0, 220);
      if (typeof parsed.mood === "number" && !Number.isNaN(parsed.mood)) {
        base.mood = Math.max(-1, Math.min(1, parsed.mood));
      }
      if (Array.isArray(parsed.symbols)) {
        base.symbols = parsed.symbols.map((s) => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 6);
      }
      if (typeof parsed.vivid === "boolean") base.vivid = parsed.vivid;
    }
  } catch (e) {
    // fall back to heuristics if the model chokes
  }
  return base;
}

async function generateImage(env, dream, userId) {
  if (!env.BUCKET) return null;
  const prompt = `A surreal dreamlike painting. Mood: ${moodName(dream.mood)}. Symbols: ${(dream.symbols || []).join(", ")}. Title: ${dream.title}. Soft twilight sky, glowing orbs, crescent moon, ethereal atmosphere, fine art, cinematic lighting, highly detailed.`;
  const model = (env && env.RENDER_MODEL) || "google/gemini-2.5-flash-image";
  try {
    const out = await imageChat(env, {
      model,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
      imageConfig: { aspect_ratio: "16:9" },
    });
    const src = findImageSource(out);
    if (!src) return null;
    const body = await imageSourceToBytes(env, src);
    if (!body) return null;
    const key = `dreams/${userId}/${dream.id}.png`;
    await env.BUCKET.put(key, body, { httpMetadata: { contentType: "image/png" } });
    return key;
  } catch (e) {
    return null;
  }
}

function computeRelive(r) {
  if (!r) return null;
  const started = Date.parse(r.startedAt || r.createdAt || new Date().toISOString());
  const eta = r.etaMs || 3600000;
  const elapsed = Date.now() - started;
  let status = r.status || "queued";
  let progress = r.progress || 0;
  let etaMs = Math.max(0, eta - elapsed);
  if (status === "queued" || status === "rendering") {
    if (elapsed < 5000) {
      status = "queued";
      progress = 0;
    } else if (elapsed < eta) {
      status = "rendering";
      progress = Math.min(99.5, (elapsed / eta) * 100);
    } else {
      status = "ready";
      progress = 100;
      etaMs = 0;
    }
  }
  return { ...r, status, progress, etaMs };
}

function serializeDream(row) {
  let symbols = [];
  try {
    symbols = JSON.parse(row.symbols || "[]");
  } catch (e) {}
  let relive = null;
  if (row.relive_json) {
    try {
      relive = computeRelive(JSON.parse(row.relive_json));
    } catch (e) {}
  }
  return {
    id: row.id,
    text: row.text,
    dreamDate: row.dream_date,
    title: row.title,
    summary: row.summary,
    mood: row.mood,
    symbols,
    vivid: !!row.vivid,
    artSeed: row.art_seed,
    imageFile: row.image_key || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    relive,
  };
}

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  // --- auth ---
  if (path === "/api/auth/register" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password || password.length < 8) {
      return json({ error: "Email and a password of at least 8 characters are required." }, 400);
    }
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return json({ error: "An account with that email already exists." }, 409);
    const user = await (async () => {
      const id = crypto.randomUUID();
      const hash = await hashPassword(password);
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?,?,?,?)")
        .bind(id, email, hash, now)
        .run();
      return { id, email };
    })();
    const token = await createSession(env, user.id);
    return json({ user }, 201, { "Set-Cookie": sessionCookie(token, isSecure(request)) });
  }

  if (path === "/api/auth/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const row = await env.DB.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").bind(email).first();
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return json({ error: "Email or password is incorrect." }, 401);
    }
    const token = await createSession(env, row.id);
    return json({ user: { id: row.id, email: row.email } }, 200, { "Set-Cookie": sessionCookie(token, isSecure(request)) });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const token = getCookie(request, "session");
    if (token) {
      await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(isSecure(request)) });
  }

  if (path === "/api/auth/me" && method === "GET") {
    const user = await getSessionUser(env, request);
    return json({ user: user || null });
  }

  // generate an image on demand
  if ((path === "/api/ai/generate-image" || path === "/api/ai/image") && method === "POST") {
    const user = await getSessionUser(env, request);
    if (!user) return json({ error: "Unauthorized" }, 401);
    const body = await request.json().catch(() => ({}));
    let dreamRow = null;
    if (body.dreamId) {
      dreamRow = await env.DB.prepare("SELECT * FROM dreams WHERE id = ? AND user_id = ?").bind(String(body.dreamId), user.id).first();
      if (!dreamRow) return json({ error: "Dream not found." }, 404);
    } else {
      const text = String(body.text || "").trim();
      if (text.length < 20) return json({ error: "A dream needs at least 20 characters." }, 400);
      const analysis = await analyzeDream(env, text);
      dreamRow = {
        id: crypto.randomUUID(),
        user_id: user.id,
        text,
        dream_date: String(body.dreamDate || new Date().toISOString().slice(0, 10)).slice(0, 10),
        title: analysis.title,
        summary: analysis.summary,
        mood: analysis.mood,
        symbols: JSON.stringify(analysis.symbols || []),
        vivid: analysis.vivid ? 1 : 0,
        art_seed: analysis.artSeed,
        image_key: null,
        relive_json: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await env.DB.prepare(
        `INSERT INTO dreams (id, user_id, text, dream_date, title, summary, mood, symbols, vivid, art_seed, image_key, relive_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(
          dreamRow.id, dreamRow.user_id, dreamRow.text, dreamRow.dream_date, dreamRow.title, dreamRow.summary,
          dreamRow.mood, dreamRow.symbols, dreamRow.vivid, dreamRow.art_seed, null, null,
          dreamRow.created_at, dreamRow.updated_at
        )
        .run();
    }
    const dream = serializeDream(dreamRow);
    const imageKey = await generateImage(env, dream, user.id);
    if (!imageKey) return json({ error: "Image generation is unavailable right now." }, 503);
    await env.DB.prepare("UPDATE dreams SET image_key = ?, updated_at = ? WHERE id = ?")
      .bind(imageKey, new Date().toISOString(), dream.id)
      .run();
    const updated = await env.DB.prepare("SELECT * FROM dreams WHERE id = ? AND user_id = ?").bind(dream.id, user.id).first();
    return json({ imageFile: imageKey, dream: serializeDream(updated) });
  }

  // --- dreams ---
  if (path.startsWith("/api/dreams")) {
    const user = await getSessionUser(env, request);
    if (!user) return json({ error: "Unauthorized" }, 401);

    // list
    if (path === "/api/dreams" && method === "GET") {
      const result = await env.DB.prepare(
        "SELECT * FROM dreams WHERE user_id = ? ORDER BY dream_date DESC, created_at DESC"
      )
        .bind(user.id)
        .all();
      const dreams = (result.results || []).map(serializeDream);
      return json({ dreams });
    }

    if (path === "/api/dreams" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const text = String(body.text || "").trim();
      if (text.length < 20) return json({ error: "A dream needs at least 20 characters." }, 400);
      if (text.length > 4000) return json({ error: "Dreams are limited to 4000 characters." }, 400);
      const dreamDate = String(body.dreamDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
      const analysis = await analyzeDream(env, text);
      await upsertSymbols(env, user.id, analysis.symbols || []);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const symbols = JSON.stringify(analysis.symbols || []);
      await env.DB.prepare(
        `INSERT INTO dreams (id, user_id, text, dream_date, title, summary, mood, symbols, vivid, art_seed, image_key, relive_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(
          id,
          user.id,
          text,
          dreamDate,
          analysis.title,
          analysis.summary,
          analysis.mood,
          symbols,
          analysis.vivid ? 1 : 0,
          analysis.artSeed,
          null,
          null,
          now,
          now
        )
        .run();

      const dreamRow = {
        id,
        user_id: user.id,
        text,
        dream_date: dreamDate,
        title: analysis.title,
        summary: analysis.summary,
        mood: analysis.mood,
        symbols,
        vivid: analysis.vivid ? 1 : 0,
        art_seed: analysis.artSeed,
        image_key: null,
        relive_json: null,
        created_at: now,
        updated_at: now,
      };

      // try to paint it; saving still succeeds if this fails
      const imageKey = await generateImage(env, serializeDream(dreamRow), user.id);
      if (imageKey) {
        await env.DB.prepare("UPDATE dreams SET image_key = ?, updated_at = ? WHERE id = ?")
          .bind(imageKey, new Date().toISOString(), id)
          .run();
        dreamRow.image_key = imageKey;
      }

      return json(serializeDream(dreamRow), 201);
    }

    // single dream routes
    const match = path.match(/^\/api\/dreams\/([^/]+)(?:\/(image|relive))?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const sub = match[2];

      const row = await env.DB.prepare("SELECT * FROM dreams WHERE id = ? AND user_id = ?").bind(id, user.id).first();
      if (!row) return json({ error: "Dream not found." }, 404);

      if (sub === "image" && method === "POST") {
        const dream = serializeDream(row);
        const imageKey = await generateImage(env, dream, user.id);
        if (!imageKey) return json({ error: "Image generation is unavailable right now." }, 503);
        await env.DB.prepare("UPDATE dreams SET image_key = ?, updated_at = ? WHERE id = ?")
          .bind(imageKey, new Date().toISOString(), id)
          .run();
        const updated = await env.DB.prepare("SELECT * FROM dreams WHERE id = ? AND user_id = ?").bind(id, user.id).first();
        return json(serializeDream(updated));
      }

      if (sub === "relive" && method === "POST") {
        if (!row.vivid) return json({ error: "Only vivid dreams can be relived." }, 400);
        const existing = row.relive_json ? JSON.parse(row.relive_json) : null;
        if (existing && (existing.status === "queued" || existing.status === "rendering")) {
          return json({ relive: computeRelive(existing) });
        }
        const relive = {
          status: "queued",
          progress: 0,
          etaMs: Math.round((1 + Math.random() * 4) * 3600000),
          startedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        };
        await env.DB.prepare("UPDATE dreams SET relive_json = ?, updated_at = ? WHERE id = ?")
          .bind(JSON.stringify(relive), new Date().toISOString(), id)
          .run();
        return json({ relive: computeRelive(relive) });
      }

      if (!sub && method === "GET") {
        return json(serializeDream(row));
      }

      if (!sub && method === "PUT") {
        const body = await request.json().catch(() => ({}));
        const text = String(body.text || row.text).trim();
        if (text.length < 20) return json({ error: "A dream needs at least 20 characters." }, 400);
        const dreamDate = String(body.dreamDate || row.dream_date).slice(0, 10);
        const analysis = await analyzeDream(env, text);
        const symbols = JSON.stringify(analysis.symbols || []);
        await env.DB.prepare(
          `UPDATE dreams SET text = ?, dream_date = ?, title = ?, summary = ?, mood = ?, symbols = ?, vivid = ?, art_seed = ?, updated_at = ? WHERE id = ? AND user_id = ?`
        )
          .bind(
            text,
            dreamDate,
            analysis.title,
            analysis.summary,
            analysis.mood,
            symbols,
            analysis.vivid ? 1 : 0,
            analysis.artSeed,
            new Date().toISOString(),
            id,
            user.id
          )
          .run();
        const updated = await env.DB.prepare("SELECT * FROM dreams WHERE id = ? AND user_id = ?").bind(id, user.id).first();
        return json({ dream: serializeDream(updated) });
      }

      if (!sub && method === "DELETE") {
        await env.DB.prepare("DELETE FROM dreams WHERE id = ? AND user_id = ?").bind(id, user.id).run();
        if (env.BUCKET && row.image_key) {
          try {
            await env.BUCKET.delete(row.image_key);
          } catch (e) {}
        }
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  }

    if (path === "/api/settings" && method === "GET") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const row = await env.DB.prepare("SELECT display_name, style_instructions, avatar_key FROM user_settings WHERE user_id = ?")
        .bind(user.id)
        .first();
      return json({ settings: row || { display_name: null, style_instructions: null, avatar_key: null } });
    }

    if (path === "/api/settings" && method === "PUT") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const displayName = body.displayName == null ? null : String(body.displayName).trim().slice(0, 60);
      const aiInstructions = body.aiInstructions == null ? null : String(body.aiInstructions).trim().slice(0, 2000);
      const existing = await env.DB.prepare("SELECT user_id FROM user_settings WHERE user_id = ?").bind(user.id).first();
      if (existing) {
        await env.DB.prepare("UPDATE user_settings SET display_name = ?, style_instructions = ?, updated_at = ? WHERE user_id = ?")
          .bind(displayName, aiInstructions, new Date().toISOString(), user.id)
          .run();
      } else {
        await env.DB.prepare("INSERT INTO user_settings (user_id, display_name, style_instructions, updated_at) VALUES (?,?,?,?)")
          .bind(user.id, displayName, aiInstructions, new Date().toISOString())
          .run();
      }
      return json({ ok: true });
    }

    if (path === "/api/avatar" && method === "POST") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const dataUrl = String(body.image || "");
      const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!m) return json({ error: "Valid image required." }, 400);
      const [, mime, b64Data] = m;
      if (b64Data.length > 3_000_000) return json({ error: "Image too large." }, 413);
      const bytes = fromB64(b64Data);
      const ext = mime.includes("png") ? "png" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
      const key = `avatars/${user.id}.${ext}`;
      await env.BUCKET.put(key, bytes.buffer, { httpMetadata: { contentType: mime } });
      const existing = await env.DB.prepare("SELECT user_id FROM user_settings WHERE user_id = ?").bind(user.id).first();
      if (existing) {
        await env.DB.prepare("UPDATE user_settings SET avatar_key = ?, updated_at = ? WHERE user_id = ?")
          .bind(key, new Date().toISOString(), user.id)
          .run();
      } else {
        await env.DB.prepare("INSERT INTO user_settings (user_id, display_name, style_instructions, avatar_key, updated_at) VALUES (?,?,?,?,?)")
          .bind(user.id, null, null, key, new Date().toISOString())
          .run();
      }
      return json({ ok: true, avatarKey: key });
    }

    if (path === "/api/export" && method === "GET") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const dreams = await env.DB.prepare("SELECT * FROM dreams WHERE user_id = ? ORDER BY dream_date DESC").bind(user.id).all();
      const chats = await env.DB.prepare("SELECT role, content, dream_id, created_at FROM chats WHERE user_id = ? ORDER BY created_at ASC").bind(user.id).all();
      const symbols = await env.DB.prepare("SELECT symbol, count, updated_at FROM symbols WHERE user_id = ? ORDER BY count DESC").bind(user.id).all();
      const settings = await env.DB.prepare("SELECT display_name, style_instructions, updated_at FROM user_settings WHERE user_id = ?").bind(user.id).first();
      return json({
        exportedAt: new Date().toISOString(),
        user: { id: user.id, email: user.email },
        settings: settings || null,
        dreams: (dreams.results || []).map(serializeDream),
        chats: chats.results || [],
        symbols: symbols.results || [],
      });
    }

// chat endpoints
    if (path === "/api/chat" && method === "GET") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const dreamId = url.searchParams.get("dreamId");
      let stmt = "SELECT role, content, created_at FROM chats WHERE user_id = ?";
      const binds = [user.id];
      if (dreamId) {
        stmt += " AND dream_id = ?";
        binds.push(dreamId);
      }
      stmt += " ORDER BY created_at ASC LIMIT 100";
      const result = await env.DB.prepare(stmt).bind(...binds).all();
      return json({ messages: result.results || [] });
    }

    if (path === "/api/chat" && method === "POST") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const message = String(body.message || "").trim();
      if (!message) return json({ error: "Message is required." }, 400);
      const dreamId = body.dreamId ? String(body.dreamId) : null;

      // save user message
      await env.DB.prepare("INSERT INTO chats (id, user_id, dream_id, role, content, created_at) VALUES (?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), user.id, dreamId, "user", message, new Date().toISOString())
        .run();

      // build context
      const dreamRow = dreamId
        ? await env.DB.prepare("SELECT text, title, symbols FROM dreams WHERE id = ? AND user_id = ?").bind(dreamId, user.id).first()
        : null;
      const historyResult = await env.DB.prepare(
        "SELECT role, content FROM chats WHERE user_id = ? AND (dream_id IS ? OR dream_id = ?) ORDER BY created_at ASC LIMIT 20"
      )
        .bind(user.id, dreamId, dreamId)
        .all();
      const history = (historyResult.results || []).map((r) => ({ role: r.role, content: r.content }));

      const settingsRow = await env.DB.prepare("SELECT style_instructions FROM user_settings WHERE user_id = ?").bind(user.id).first();
      const aiInstructions = settingsRow && settingsRow.style_instructions ? settingsRow.style_instructions : "";
      const systemPrompt =
        "You are a warm, thoughtful companion for someone's dream journal. " +
        "Talk about their dreams, the symbols and feelings in them, and patterns across nights. " +
        "Ask gentle questions. Never claim a fixed meaning for a dream; offer possibilities. " +
        "Keep replies under 120 words." +
        (aiInstructions ? " Additional guidance from the user: " + aiInstructions : "");
      const messages = [{ role: "system", content: systemPrompt }];
      if (dreamRow) {
        messages.push({
          role: "system",
          content: `Current dream: "${dreamRow.title}". Text: ${String(dreamRow.text).slice(0, 1500)}. Symbols: ${dreamRow.symbols || "[]"}.`,
        });
      }
      messages.push(...history);

      let reply = "I'm here. Tell me more about the dream.";
      try {
        const out = await imageChat(env, {
          model: "openai/gpt-oss-20b",
          messages,
        });
        reply = out && out.choices && out.choices[0] && out.choices[0].message
          ? String(out.choices[0].message.content || "").trim() || reply
          : reply;
      } catch (e) {
        reply = "I had trouble reaching the painter just now, but I'm listening. What stood out most in the dream?";
      }

      await env.DB.prepare("INSERT INTO chats (id, user_id, dream_id, role, content, created_at) VALUES (?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), user.id, dreamId, "reply", reply, new Date().toISOString())
        .run();

      // save symbols from the user message and dream
      const syms = heuristicSymbols(message);
      if (dreamRow && dreamRow.symbols) {
        try {
          const ds = JSON.parse(dreamRow.symbols);
          if (Array.isArray(ds)) syms.push(...ds);
        } catch (e) {}
      }
      await upsertSymbols(env, user.id, syms);

      return json({ reply });
    }

    if (path === "/api/symbols" && method === "GET") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const result = await env.DB.prepare("SELECT symbol, count, updated_at FROM symbols WHERE user_id = ? ORDER BY count DESC, symbol ASC")
        .bind(user.id)
        .all();
      return json({ symbols: result.results || [] });
    }

    if (path === "/api/symbols" && method === "POST") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const symbol = String(body.symbol || "").trim().toLowerCase();
      if (!symbol) return json({ error: "Symbol is required." }, 400);
      await upsertSymbols(env, user.id, [symbol]);
      return json({ ok: true });
    }

  return json({ error: "Not found" }, 404);
}

async function serveImage(request, env, url) {
  if (!env.BUCKET) return new Response("Storage not configured", { status: 503 });
  const key = decodeURIComponent(url.pathname.replace(/^\/images\//, ""));
  if (!key) return new Response("Not found", { status: 404 });
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  if (obj.writeHttpMetadata) obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}
