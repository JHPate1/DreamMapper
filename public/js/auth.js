/* ─────────────────────────────────────────────────────────
   Dream Mapper  -  auth.js (login.html / register.html)
   Session check · form submit · green banner · redirect
   ───────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const REDIRECT_TO = "/dashboard.html";
const REDIRECT_DELAY_MS = 1800;

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

/* ── Green banner ───────────────────────────────────────── */
function showBanner(msg) {
  $("successMsg").textContent = msg;
  $("successBanner").classList.remove("hidden");
}

function redirectSoon() {
  setTimeout(() => (window.location.href = REDIRECT_TO), REDIRECT_DELAY_MS);
}

/* ── Already signed in? Bounce home ─────────────────────── */
(async function checkSession() {
  try {
    const data = await api("/api/auth/me");
    if (data.user) {
      showBanner("Already signed in  -  redirecting…");
      redirectSoon();
    }
  } catch {
    /* server unreachable  -  let the form try anyway */
  }
})();

/* ── Login ───────────────────────────────────────────────── */
const loginForm = $("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = $("loginError");
    const btn = loginForm.querySelector("button[type=submit]");
    errorEl.textContent = "";

    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: {
          email: $("loginEmail").value.trim().toLowerCase(),
          password: $("loginPassword").value,
        },
      });
      showBanner("Login successful  -  redirecting…");
      redirectSoon();
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });
}

/* ── Register ───────────────────────────────────────────── */
const registerForm = $("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = $("registerError");
    const btn = registerForm.querySelector("button[type=submit]");
    errorEl.textContent = "";

    if ($("regPassword").value !== $("regPassword2").value) {
      errorEl.textContent = "The passwords don't match.";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Creating account…";
    try {
      await api("/api/auth/register", {
        method: "POST",
        body: {
          email: $("regEmail").value.trim().toLowerCase(),
          password: $("regPassword").value,
        },
      });
      showBanner("Account created  -  redirecting…");
      redirectSoon();
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Create account";
    }
  });
}