# monostudy v3

JEE / NEET prep: syllabus tracker, PYQ vault, flashcards, error log, notes, planner, analytics, PWA.

## Run it — three ways
| How | Needs | You get |
|---|---|---|
| **Double-click `index.html`** (`file://`) | nothing | Everything works. Accounts and data live in this browser only. |
| **`node server.js`** → http://localhost:3000 | Node 18+, no `npm install` | Server accounts, cloud sync across devices, offline PWA, REST + GraphQL API. |
| Any static host | — | Same as double-click (+ PWA over https). |
| **Firebase** (see `FIREBASE_SETUP.md`) | Firebase project + `firebase-config.js` | Google / email / phone sign-in, Firestore sync across devices, live updates. Over http(s) only. |

## How the pieces connect
```
index.html ──loads──> chapter-data.js, pyq-data.js   (window.MONO_CHAPTERS / MONO_PYQ — no fetch, so file:// works)
           └─loads──> app.js ── localStorage (one bucket per account; guests keep the v2 key)
                         │
                         └── if served over http and /api/health answers:
                               /api/auth/*          register · login · phone OTP        (server.js)
                               /api/v1/state        whole-state sync, last-write-wins   (data/state/<id>.json)
                               /api/v1/sync/bulk    "Push local data" in one request
                               /api/chapters/:id/status, /api/v1/practice/log-attempt
service-worker.js caches the shell + data for offline use (http/https only)
```
`chapter-data.json` / `pyq-data.json` are the source of truth. After editing them run `python3 tools/build-data.py` to regenerate the `.js` twins and validate that every question's `chapterId` exists.

## File access features
- **Settings → Import questions (.json)** adds your own PYQs (validated; max 5 MB). Click *Question file template* for the format. Imported questions are included in backups and cloud sync.
- **Export / Import backup** — full state as JSON (max 12 MB on import).
- Weekly summary card downloads as PNG.

## Accounts: which one is used?
1. `firebase-config.js` filled in and page served over http(s) → **Firebase** (server/local accounts ignored).
2. Else served by `node server.js` → server accounts + sync.
3. Else (file://) → local accounts in this browser.

## Security notes (read before deploying)
- Passwords on the server use scrypt; tokens are HMAC-signed (30 days). Set `MONO_SECRET` and `NODE_ENV=production` in real use (production hides the dev OTP).
- **No SMS provider and no Google OAuth client are configured.** Phone OTP prints to the server console (and is returned to the page outside production). Google sign-in shows a message.
- Offline (file://) accounts are a convenience to separate profiles on one device, not security: anyone with access to the browser profile can read localStorage.
- `data/` holds users, secret and state — keep it out of version control and backups you share.

## Data caveats
`pyq-data.json` contains 12 **demo** questions, not official past papers. Chapter weightage/frequency bands are **provisional estimates** written for planning.
