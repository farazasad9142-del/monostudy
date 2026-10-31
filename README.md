# monostudy v2 (PrepSphere roadmap build)

Run: `node server.js` → http://localhost:3000 (Node 18+, no npm install). Opening index.html from disk cannot load the JSON data (browser fetch restriction) — use the server or any static host.

Skipped on purpose (crossed out in the roadmap): cloud auth, IndexedDB sync workers.
Built: weightage/frequency syllabus + 4-status tracker, PYQ vault (filters, KaTeX, confidence/time logging), flashcards (swipe), error log, Markdown notes + image attachments, weak-spot heatmap, "High Yield • Low Accuracy" list, time-vs-goal chart, streak with 1 grace day, tagged Pomodoro with sound, weekly summary PNG, PWA (manifest + service worker + mobile bottom nav), server rate limiting/validation/security headers, POST /api/v1/practice/log-attempt, GET /api/pyq.

Data notes: pyq-data.json holds 12 DEMO questions, not official PYQs. Weightage/frequency bands are provisional estimates. RLS, load testing and CDN rules need a real database/host and are not part of this folder.
