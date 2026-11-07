/* monostudy ↔ Firebase adapter (classic script → window.MonoFirebase).
   Auth: email/password, Google, phone OTP, password reset.  Data: Firestore users/{uid} (+ images subcollection).
   Inert unless firebase-config.js is filled in AND the page is served over http(s) — Firebase Auth does not run on file://. */
(function () {
  "use strict";
  const VERSION = "10.14.1", BASE = `https://www.gstatic.com/firebasejs/${VERSION}/`;
  const cfg = window.MONO_FIREBASE || {};
  const enabled = !!(cfg.apiKey && cfg.projectId && cfg.appId) && /^https?:$/.test(location.protocol);
  const M = { enabled, ok: false, cfg };
  window.MonoFirebase = M;
  if (!enabled) return;

  let sdk = null, auth = null, db = null, initP = null, confirmation = null, verifier = null, unwatch = null;
  const uploaded = new Set();                 // image ids known to exist in Firestore
  const MAX_DOC_BYTES = 900000;               // Firestore hard limit is 1 MiB per document

  async function load() {
    if (sdk) return sdk;
    const [app, a, f] = await Promise.all([import(BASE + "firebase-app.js"), import(BASE + "firebase-auth.js"), import(BASE + "firebase-firestore.js")]);
    const ap = app.initializeApp(cfg);
    auth = a.getAuth(ap); db = f.getFirestore(ap);
    return (sdk = { a, f });
  }
  const toUser = u => u ? { id: u.uid, name: u.displayName || "", email: u.email || null, phone: u.phoneNumber || null, verified: !!u.emailVerified } : null;
  const needUid = () => { const u = auth && auth.currentUser; if (!u) throw Object.assign(new Error("Not signed in"), { code: "app/not-signed-in" }); return u.uid; };

  /* ---------- auth ---------- */
  // Resolves with the restored user (or null). Rejects only if the SDK itself cannot load (offline first run).
  M.init = () => initP || (initP = (async () => {
    const { a } = await load();
    try { await a.getRedirectResult(auth); } catch (e) { M.redirectError = e; }      // completes a Google redirect sign-in
    const u = await new Promise(res => { const off = a.onAuthStateChanged(auth, x => { off(); res(x); }); });
    M.ok = true;
    return toUser(u);
  })());
  M.register = async (email, password, name) => {
    const { a } = await load();
    const c = await a.createUserWithEmailAndPassword(auth, email, password);
    if (name) { try { await a.updateProfile(c.user, { displayName: name }); } catch {} }
    try { await a.sendEmailVerification(c.user); } catch {}
    M.ok = true; return toUser(auth.currentUser);
  };
  M.login = async (email, password) => { const { a } = await load(); await a.signInWithEmailAndPassword(auth, email, password); M.ok = true; return toUser(auth.currentUser); };
  M.google = async () => {
    const { a } = await load(); const p = new a.GoogleAuthProvider();
    try { await a.signInWithPopup(auth, p); }
    catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") { await a.signInWithRedirect(auth, p); return new Promise(() => {}); }   // page navigates away
      throw e;
    }
    M.ok = true; return toUser(auth.currentUser);
  };
  M.reset = async email => { const { a } = await load(); await a.sendPasswordResetEmail(auth, email); };
  // Firebase needs E.164 (+<country><number>); we never guess a country code.
  M.phoneSend = async raw => {
    const phone = String(raw || "").replace(/[\s()-]/g, "");
    if (!/^\+\d{8,15}$/.test(phone)) throw Object.assign(new Error("Include the country code, e.g. +91 98765 43210"), { code: "app/bad-phone" });
    const { a } = await load();
    try { if (verifier) { try { verifier.clear(); } catch {} } verifier = new a.RecaptchaVerifier(auth, "recaptcha-container", { size: "invisible" }); confirmation = await a.signInWithPhoneNumber(auth, phone, verifier); }
    catch (e) { try { verifier && verifier.clear(); } catch {} verifier = null; throw e; }
  };
  M.phoneVerify = async code => {
    if (!confirmation) throw Object.assign(new Error("Request an OTP first"), { code: "app/no-otp" });
    await confirmation.confirm(code); confirmation = null; M.ok = true; return toUser(auth.currentUser);
  };
  M.signOut = async () => { const { a } = await load(); if (unwatch) { unwatch(); unwatch = null; } await a.signOut(auth); M.ok = false; };
  M.friendly = e => {
    const c = (e && e.code) || "";
    const t = {
      "auth/invalid-email": "That email address isn't valid", "auth/user-not-found": "Wrong email or password", "auth/wrong-password": "Wrong email or password",
      "auth/invalid-credential": "Wrong email or password", "auth/email-already-in-use": "An account with this email already exists", "auth/weak-password": "Password must be at least 6 characters",
      "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again", "auth/network-request-failed": "Can't reach Firebase — check your connection",
      "auth/popup-closed-by-user": "Sign-in was cancelled", "auth/cancelled-popup-request": "Sign-in was cancelled", "auth/invalid-phone-number": "That phone number isn't valid",
      "auth/invalid-verification-code": "Wrong OTP", "auth/code-expired": "OTP expired. Request a new one", "auth/quota-exceeded": "SMS limit reached. Try again later",
      "auth/operation-not-allowed": "This sign-in method isn't enabled in the Firebase console", "auth/unauthorized-domain": "This domain isn't listed under Firebase Authentication → Authorized domains",
      "auth/missing-phone-number": "Enter your mobile number", "permission-denied": "Firestore rules blocked this — deploy firestore.rules",
    };
    return t[c] || (e && e.message) || "Something went wrong";
  };

  /* ---------- Firestore: users/{uid} {schema,updatedAt,data,trimmed}; users/{uid}/images/{id} {data} ---------- */
  const cyrb = s => { let a = 0xdeadbeef, b = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909); b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36); };
  const bytes = s => new TextEncoder().encode(s).length;

  // Pull note images out of the state (they are big data: URLs) and leave "fbimg:<id>" references.
  function pack(state) {
    const s = JSON.parse(JSON.stringify(state)), imgs = {};
    for (const n of s.notes || []) n.images = (n.images || []).map(d => {
      if (typeof d !== "string" || !d.startsWith("data:")) return d;
      const id = cyrb(d) + "-" + d.length.toString(36); imgs[id] = d; return "fbimg:" + id; });
    return { s, imgs };
  }
  async function unpack(doc) {
    const { f } = sdk, uid = needUid();
    const state = JSON.parse(doc.data); const need = new Set();
    for (const n of state.notes || []) for (const d of n.images || []) if (typeof d === "string" && d.startsWith("fbimg:")) need.add(d.slice(6));
    const got = {};
    await Promise.all([...need].map(async id => { try { const sn = await f.getDoc(f.doc(db, "users", uid, "images", id)); if (sn.exists()) { got[id] = sn.data().data; uploaded.add(id); } } catch {} }));
    for (const n of state.notes || []) n.images = (n.images || []).map(d => typeof d === "string" && d.startsWith("fbimg:") ? got[d.slice(6)] : d).filter(Boolean);
    state.updatedAt = doc.updatedAt; return state;
  }
  M.saveState = async state => {
    const { f } = await load(), uid = needUid();
    const { s, imgs } = pack(state);
    let trimmed = false, data = JSON.stringify(s);
    if (bytes(data) > MAX_DOC_BYTES) { s.attempts = (s.attempts || []).slice(-1000); s.sessions = (s.sessions || []).slice(-1000); data = JSON.stringify(s); trimmed = true; }
    if (bytes(data) > MAX_DOC_BYTES) throw Object.assign(new Error("Too much data to sync — remove some notes or imported questions"), { code: "app/too-large" });
    const fresh = Object.keys(imgs).filter(id => !uploaded.has(id));
    for (let i = 0; i < fresh.length; i += 20) {                       // images first, so the main doc never points at a missing image
      const b = f.writeBatch(db); fresh.slice(i, i + 20).forEach(id => b.set(f.doc(db, "users", uid, "images", id), { data: imgs[id] })); await b.commit();
      fresh.slice(i, i + 20).forEach(id => uploaded.add(id));
    }
    await f.setDoc(f.doc(db, "users", uid), { schema: 2, updatedAt: Number(state.updatedAt) || Date.now(), data, trimmed });
    return { trimmed };
  };
  M.loadState = async () => {
    const { f } = await load(), uid = needUid();
    const sn = await f.getDoc(f.doc(db, "users", uid)); if (!sn.exists()) return null;
    const d = sn.data(); return unpack({ data: d.data, updatedAt: d.updatedAt });
  };
  // Live updates from other devices. cb receives a full state whose updatedAt is newer than anything we have seen.
  M.watch = cb => {
    if (unwatch) unwatch();
    const { f } = sdk, uid = needUid(); let seen = 0;
    unwatch = f.onSnapshot(f.doc(db, "users", uid), sn => {
      if (!sn.exists() || (sn.metadata && sn.metadata.hasPendingWrites)) return;
      const d = sn.data(); if (!d || d.updatedAt <= seen) return; seen = d.updatedAt;
      unpack({ data: d.data, updatedAt: d.updatedAt }).then(cb).catch(() => {});
    }, () => {});
  };
})();
