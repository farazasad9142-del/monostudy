# Firebase setup (≈10 minutes)

The code is done; you only need to create the Firebase project and paste its config.

## 1. Create the project
1. https://console.firebase.google.com → **Add project**.
2. **Build → Authentication → Get started → Sign-in method**, enable:
   - **Email/Password**
   - **Google** (pick a support email)
   - **Phone** (see "Phone OTP" below)
3. **Build → Firestore Database → Create database** → *Production mode* → choose a region near your users (e.g. `asia-south1` Mumbai).
4. **Project settings (⚙) → Your apps → Web (`</>`)** → register the app → copy the `firebaseConfig` values.

## 2. Paste the config
Open `firebase-config.js` and fill in `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`.
These identify the project and are safe to ship; your data is protected by the rules in step 3.

## 3. Deploy the security rules (do not skip)
```bash
npm i -g firebase-tools
firebase login
# put your project id in .firebaserc, then:
firebase deploy --only firestore:rules
```
Without them Firestore (in production mode) rejects every request and sync shows "Firestore rules blocked this".
Rules: each user can read/write only `users/{their uid}` and its `images` subcollection; field names and sizes are validated.

## 4. Run / host
- **Local:** `node server.js` → http://localhost:3000 (`localhost` is pre-authorised for sign-in). Or any static server.
- **Hosting:** `firebase deploy --only hosting` → `https://<project>.web.app` (authorised automatically; `firebase.json` already excludes server.js, data/, tools/, *.md).
- **Your own domain:** Authentication → Settings → **Authorized domains** → add it. (`auth/unauthorized-domain` means this is missing.)
- `file://` cannot use Firebase Auth. Opening index.html from disk falls back to local accounts automatically.

## Phone OTP
- Real SMS requires the **Blaze (pay-as-you-go) plan**; there is a free monthly quota, then per-SMS charges that vary by country.
- Free testing: Authentication → Sign-in method → Phone → **Phone numbers for testing** (fixed number + code, no SMS sent).
- Numbers must include the country code (`+91…`); the app never guesses one.
- The invisible reCAPTCHA uses `#recaptcha-container` (already in index.html).

## How data is stored
| Path | Content |
|---|---|
| `users/{uid}` | `{ schema:2, updatedAt, data:<JSON string of your whole progress>, trimmed }` |
| `users/{uid}/images/{id}` | one note image (`data:image/jpeg…`, ≤ 500 KB each) |

- Images live in their own documents because a Firestore document is limited to 1 MiB.
- If the progress JSON ever exceeds ~900 KB, the cloud copy keeps your latest 1000 attempts/sessions and tells you (local data is never trimmed).
- Sync: edits upload 2.5 s after the last change; other signed-in devices receive them live. Conflicts are **last write wins** by `updatedAt`.
- Unused images (from deleted notes) are not garbage-collected yet.

## Things that are your call
- **App Check** (Firebase console) is recommended before launch to stop abuse of your API key from other sites.
- Firestore pricing: each save is ~1 write plus new images; each device open is ~1 read.
- The Node server is now optional: with Firebase configured it is only needed for its REST/GraphQL API. Its own accounts are not used.
