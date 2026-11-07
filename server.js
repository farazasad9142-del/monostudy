// monostudy server — Node 18+ built-ins only (no npm install).
// Serves the frontend + REST/GraphQL API + accounts + per-user cloud sync.
"use strict";
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000), ROOT = __dirname;
const DATA = path.join(ROOT, "data");                      // all writable state lives here
fs.mkdirSync(path.join(DATA, "state"), { recursive: true });
const F = {
  users: path.join(DATA, "users.json"), status: path.join(DATA, "chapter-status.json"),
  attempts: path.join(DATA, "attempts.json"), secret: path.join(DATA, ".secret"),
};
const catalog = require("./chapter-data.json"), pyq = require("./pyq-data.json");
const CHAPTER_IDS = new Set(catalog.chapters.map(c => c.id));
const VALID = new Set(["Not Started", "In Progress", "Revised", "Mastered"]);
const PROD = process.env.NODE_ENV === "production";

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
// Whitelist of files the static server may expose (keeps users.json, secrets etc. private).
const PUBLIC = new Set(["index.html", "style.css", "app.js", "manifest.json", "service-worker.js",
  "firebase-config.js", "firebase-layer.js", "chapter-data.json", "chapter-data.js", "pyq-data.json", "pyq-data.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"]);

/* ---------- tiny JSON store (atomic writes) ---------- */
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, v) => { fs.writeFileSync(f + ".tmp", JSON.stringify(v)); fs.renameSync(f + ".tmp", f); };
const safeId = s => /^[A-Za-z0-9_-]{1,64}$/.test(String(s || ""));

/* ---------- http helpers ---------- */
const HEAD = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
};
const send = (res, code, body) => {
  res.writeHead(code, { ...HEAD, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(code === 204 ? "" : JSON.stringify(body));
};
// per-IP limits: 300 req/min overall, 12 auth attempts/min
const hits = new Map(), authHits = new Map();
setInterval(() => { hits.clear(); authHits.clear(); }, 60000).unref();
const bump = (m, ip) => { const n = (m.get(ip) || 0) + 1; m.set(ip, n); return n; };
const bodyOf = (req, max = 1e6) => new Promise((ok, bad) => {
  let d = "", n = 0;
  req.on("data", c => { n += c.length; if (n > max) { bad(new Error("Body too large")); req.destroy(); } else d += c; });
  req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { bad(new Error("Invalid JSON body")); } });
  req.on("error", bad);
});

/* ---------- accounts + signed tokens ---------- */
let SECRET = process.env.MONO_SECRET;
if (!SECRET) { try { SECRET = fs.readFileSync(F.secret, "utf8"); } catch { SECRET = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(F.secret, SECRET, { mode: 0o600 }); } }
const b64 = b => Buffer.from(b).toString("base64url");
const sign = p => crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
const mint = uid => { const p = b64(JSON.stringify({ uid, exp: Date.now() + 30 * 864e5 })); return p + "." + sign(p); };
function verify(tok) {
  const [p, s] = String(tok || "").split(".");
  if (!p || !s) return null;
  const good = sign(p);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url")); return o.exp > Date.now() && safeId(o.uid) ? o.uid : null; } catch { return null; }
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicUser = u => ({ id: u.id, name: u.name || "", email: u.email || null, phone: u.phone || null });
// who is calling? signed token → account id; else anonymous device id header; else shared "_global"
function whoAmI(req) {
  const a = req.headers.authorization || "";
  if (a.startsWith("Bearer ")) { const u = verify(a.slice(7)); if (u) return { id: u, authed: true }; }
  const x = req.headers["x-user-id"];
  return { id: safeId(x) ? x : "_global", authed: false };
}
const otps = new Map();   // phone -> {code, exp, tries}
const normPhone = p => { const s = String(p || "").replace(/[^\d+]/g, ""); return /^\+?\d{10,15}$/.test(s) ? s : null; };

/* ---------- static files ---------- */
function serveStatic(req, res, pathname) {
  let rel; try { rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)); } catch { return send(res, 400, { error: "Bad path" }); }
  if (!PUBLIC.has(rel)) return send(res, 404, { error: "Not found" });
  fs.readFile(path.join(ROOT, rel), (e, buf) => {
    if (e) return send(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": (MIME[path.extname(rel)] || "application/octet-stream") + "; charset=utf-8",
      "Cache-Control": rel === "service-worker.js" ? "no-cache" : "public, max-age=300", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? "" : buf);
  });
}

/* ---------- domain helpers ---------- */
const statusOf = (uid) => { const all = readJSON(F.status, {}); return all[uid] || {}; };
const setStatuses = (uid, patch) => { const all = readJSON(F.status, {}); all[uid] = { ...(all[uid] || {}), ...patch }; writeJSON(F.status, all); return all[uid]; };
const view = (c, s) => ({ ...c, status: s[c.id] || "Not Started" });
const accuracyFor = (attempts, chapterId) => {
  const l = attempts.filter(a => a.chapter_id === chapterId);
  return { attempts: l.length, accuracy: l.length ? Math.round(l.filter(a => a.is_correct).length / l.length * 100) : null };
};
// returns an error string or null; used by single + bulk attempt logging
function checkAttempt(b) {
  const err = [];
  if (!pyq.questions.some(x => x.id === b.question_id)) err.push("question_id");
  if (typeof b.is_correct !== "boolean") err.push("is_correct");
  if (!Number.isInteger(b.time_taken_seconds) || b.time_taken_seconds < 0 || b.time_taken_seconds > 7200) err.push("time_taken_seconds");
  if (!["LOW", "MEDIUM", "HIGH"].includes(b.confidence_rating)) err.push("confidence_rating");
  return err.length ? "Invalid fields: " + err.join(", ") : null;
}
const toRow = (uid, b) => ({
  user_id: uid, question_id: b.question_id, chapter_id: (pyq.questions.find(x => x.id === b.question_id) || {}).chapterId,
  selected_option: String(b.selected_option || "").slice(0, 2), is_correct: b.is_correct, time_taken_seconds: b.time_taken_seconds,
  confidence_rating: b.confidence_rating, error_category: b.error_category ? String(b.error_category).slice(0, 40) : null, ts: new Date().toISOString(),
});

async function handle(req, res) {
  if (req.method === "OPTIONS") return send(res, 204);
  const ip = req.socket.remoteAddress || "?";
  if (bump(hits, ip) > 300) return send(res, 429, { error: "Too many requests" });
  let url; try { url = new URL(req.url.replace(/^\/{2,}/, "/"), "http://localhost"); } catch { return send(res, 400, { error: "Bad request URL" }); }
  const p = url.pathname;
  const isRead = req.method === "GET" || req.method === "HEAD";
  if (isRead && !p.startsWith("/api/") && p !== "/graphql") return serveStatic(req, res, p);
  const me = whoAmI(req);
  const body = async (max) => { try { return [await bodyOf(req, max), null]; } catch (e) { return [null, e.message]; } };

  if (req.method === "GET" && p === "/api/health") return send(res, 200, { ok: true, service: "monostudy-api", auth: true });

  /* ----- auth ----- */
  if (req.method === "POST" && p.startsWith("/api/auth/")) {
    if (bump(authHits, ip) > 12) return send(res, 429, { error: "Too many sign-in attempts. Wait a minute." });
    const [b, e] = await body(); if (e) return send(res, 400, { error: e });
    const users = readJSON(F.users, {});
    if (p === "/api/auth/register") {
      const email = String(b.email || "").trim().toLowerCase(), pw = String(b.password || "");
      if (!/^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/.test(email)) return send(res, 400, { error: "Enter a valid email" });
      if (pw.length < 8) return send(res, 400, { error: "Password must be at least 8 characters" });
      if (Object.values(users).some(u => u.email === email)) return send(res, 409, { error: "An account with this email already exists" });
      const id = "u_" + crypto.randomBytes(8).toString("hex"), salt = crypto.randomBytes(16).toString("hex");
      users[id] = { id, email, name: String(b.name || "").trim().slice(0, 40), salt, hash: hashPw(pw, salt), created: new Date().toISOString() };
      writeJSON(F.users, users);
      return send(res, 201, { token: mint(id), user: publicUser(users[id]) });
    }
    if (p === "/api/auth/login") {
      const email = String(b.email || "").trim().toLowerCase(), u = Object.values(users).find(x => x.email === email);
      const probe = u ? u.hash : "0".repeat(128);                       // same work whether or not the user exists
      const ok = same(hashPw(String(b.password || ""), u ? u.salt : "x"), probe) && !!u;
      return ok ? send(res, 200, { token: mint(u.id), user: publicUser(u) }) : send(res, 401, { error: "Wrong email or password" });
    }
    if (p === "/api/auth/otp/send") {
      const phone = normPhone(b.phone); if (!phone) return send(res, 400, { error: "Enter a valid mobile number" });
      const code = String(crypto.randomInt(0, 10000)).padStart(4, "0");
      otps.set(phone, { code, exp: Date.now() + 5 * 60000, tries: 0 });
      console.log(`[OTP] ${phone} -> ${code}   (no SMS provider configured)`);
      return send(res, 200, { sent: true, ...(PROD ? {} : { devCode: code }) });   // devCode only outside production
    }
    if (p === "/api/auth/otp/verify") {
      const phone = normPhone(b.phone), o = otps.get(phone);
      if (!o || o.exp < Date.now()) return send(res, 400, { error: "OTP expired. Request a new one." });
      if (++o.tries > 5) { otps.delete(phone); return send(res, 429, { error: "Too many wrong codes. Request a new OTP." }); }
      if (!same(String(b.code || ""), o.code)) return send(res, 401, { error: "Wrong OTP" });
      otps.delete(phone);
      let u = Object.values(users).find(x => x.phone === phone);
      if (!u) { const id = "u_" + crypto.randomBytes(8).toString("hex"); u = users[id] = { id, phone, name: "", created: new Date().toISOString() }; writeJSON(F.users, users); }
      return send(res, 200, { token: mint(u.id), user: publicUser(u) });
    }
    if (p === "/api/auth/google") return send(res, 501, { error: "Google sign-in needs an OAuth client ID that is not configured on this server." });
    return send(res, 404, { error: "Not found" });
  }
  if (req.method === "GET" && p === "/api/auth/me") {
    if (!me.authed) return send(res, 401, { error: "Not signed in" });
    const u = readJSON(F.users, {})[me.id]; return u ? send(res, 200, { user: publicUser(u) }) : send(res, 401, { error: "Account not found" });
  }

  /* ----- whole-state cloud sync (signed-in users only) ----- */
  if (p === "/api/v1/state") {
    if (!me.authed) return send(res, 401, { error: "Sign in to sync" });
    const file = path.join(DATA, "state", me.id + ".json");
    if (req.method === "GET") return send(res, 200, { state: readJSON(file, null) });
    if (req.method === "PUT") {
      const [b, e] = await body(12e6); if (e) return send(res, e === "Body too large" ? 413 : 400, { error: e });
      const s = b.state;
      if (!s || typeof s !== "object" || Array.isArray(s) || s.v !== 2) return send(res, 400, { error: "state must be a v2 object" });
      s.updatedAt = Number(s.updatedAt) || Date.now(); writeJSON(file, s); return send(res, 200, { saved: true, updatedAt: s.updatedAt });
    }
  }

  /* ----- chapters ----- */
  if (req.method === "GET" && p === "/api/chapters") {
    let l = catalog.chapters; const c = url.searchParams.get("class"), s = url.searchParams.get("subject");
    if (c) l = l.filter(x => x.class === Number(c));
    if (s) l = l.filter(x => x.subject.toLowerCase() === s.toLowerCase());
    const st = statusOf(me.id); return send(res, 200, { schemaVersion: catalog.schemaVersion, total: l.length, chapters: l.map(x => view(x, st)) });
  }
  if (req.method === "GET" && p === "/api/status") return send(res, 200, { statuses: statusOf(me.id) });
  const m = p.match(/^\/api\/chapters\/([^/]+)\/status$/);
  if (req.method === "PATCH" && m) {
    let id; try { id = decodeURIComponent(m[1]); } catch { return send(res, 400, { error: "Bad id" }); }
    const ch = catalog.chapters.find(c => c.id === id); if (!ch) return send(res, 404, { error: "Chapter not found" });
    const [b, e] = await body(); if (e) return send(res, 400, { error: e });
    if (!VALID.has(b.status)) return send(res, 400, { error: "status must be one of: " + [...VALID].join(", ") });
    const st = setStatuses(me.id, { [id]: b.status }); return send(res, 200, { chapter: view(ch, st), updated: true });
  }

  /* ----- PYQ ----- */
  if (req.method === "GET" && p === "/api/pyq") {
    const q = url.searchParams; let l = pyq.questions;
    for (const k of ["subject", "chapterId", "difficulty", "exam"]) { const v = q.get(k); if (v) l = l.filter(x => String(x[k]).toLowerCase() === v.toLowerCase()); }
    const tag = q.get("tag"); if (tag) l = l.filter(x => x.tags.some(t => t.toLowerCase() === tag.toLowerCase()));
    const s = q.get("q"); if (s) l = l.filter(x => (x.q + " " + x.tags.join(" ")).toLowerCase().includes(s.toLowerCase()));
    return send(res, 200, { notice: pyq.notice, total: l.length, questions: l });
  }
  if (req.method === "POST" && p === "/api/v1/practice/log-attempt") {
    const [b, e] = await body(); if (e) return send(res, 400, { error: e });
    const uid = me.authed ? me.id : b.user_id;                     // a signed token always wins over a body field
    if (typeof uid !== "string" || !safeId(uid)) return send(res, 400, { error: "Invalid fields: user_id" });
    const err = checkAttempt(b); if (err) return send(res, 400, { error: err });
    const all = readJSON(F.attempts, []); const row = toRow(uid, b); all.push(row); writeJSON(F.attempts, all.slice(-20000));
    return send(res, 201, { logged: true, chapter_id: row.chapter_id, analytics: accuracyFor(all.filter(a => a.user_id === uid), row.chapter_id) });
  }
  // One request instead of 200+, so "push all" no longer trips the rate limiter.
  if (req.method === "POST" && p === "/api/v1/sync/bulk") {
    const [b, e] = await body(5e6); if (e) return send(res, 400, { error: e });
    const uid = me.authed ? me.id : b.user_id;
    if (typeof uid !== "string" || !safeId(uid)) return send(res, 400, { error: "Invalid fields: user_id" });
    const patch = {}; let badStatus = 0;
    for (const [id, s] of Object.entries(b.statuses || {})) { if (CHAPTER_IDS.has(id) && VALID.has(s)) patch[id] = s; else badStatus++; }
    if (Object.keys(patch).length) setStatuses(uid, patch);
    const all = readJSON(F.attempts, []); let added = 0, skipped = 0;
    const seen = new Set(all.filter(a => a.user_id === uid).map(a => a.ts + "|" + a.question_id));
    for (const a of Array.isArray(b.attempts) ? b.attempts.slice(-500) : []) {
      if (checkAttempt(a)) { skipped++; continue; }
      const row = toRow(uid, a); if (a.ts && !isNaN(Date.parse(a.ts))) row.ts = new Date(a.ts).toISOString();
      const key = row.ts + "|" + row.question_id; if (seen.has(key)) { skipped++; continue; }
      seen.add(key); all.push(row); added++;
    }
    writeJSON(F.attempts, all.slice(-20000));
    return send(res, 200, { statuses: Object.keys(patch).length, attemptsAdded: added, attemptsSkipped: skipped, statusesRejected: badStatus });
  }

  /* ----- GraphQL (minimal) ----- */
  if (req.method === "POST" && p === "/graphql") {
    const [b, e] = await body(); if (e) return send(res, 400, { errors: [{ message: e }] });
    const query = String(b.query || ""), v = b.variables || {}, st = statusOf(me.id);
    if (/\bupdateChapterStatus\b/.test(query)) {
      const id = v.id ?? (query.match(/\bid\s*:\s*"([^"]+)"/) || [])[1], status = v.status ?? (query.match(/\bstatus\s*:\s*"([^"]+)"/) || [])[1];
      const ch = catalog.chapters.find(c => c.id === id);
      if (!ch) return send(res, 200, { errors: [{ message: "Chapter not found" }] });
      if (!VALID.has(status)) return send(res, 200, { errors: [{ message: "Invalid status" }] });
      const ns = setStatuses(me.id, { [id]: status }); return send(res, 200, { data: { updateChapterStatus: view(ch, ns) } });
    }
    if (/\bchapters\b/.test(query)) {
      let l = catalog.chapters;
      const c = v.class ?? (query.match(/\bclass\s*:\s*(\d+)/) || [])[1], s = v.subject ?? (query.match(/\bsubject\s*:\s*"([^"]+)"/) || [])[1];
      if (c) l = l.filter(x => x.class === Number(c));
      if (s) l = l.filter(x => x.subject.toLowerCase() === String(s).toLowerCase());
      return send(res, 200, { data: { chapters: l.map(x => view(x, st)) } });
    }
    return send(res, 400, { errors: [{ message: "Supported: chapters, updateChapterStatus" }] });
  }
  return send(res, 404, { error: "Not found" });
}
http.createServer((q, r) => handle(q, r).catch(err => { console.error(err); if (!r.headersSent) send(r, 500, { error: "Internal server error" }); }))
  .listen(PORT, () => console.log(`monostudy on http://localhost:${PORT}`));
