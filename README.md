# TripPlannerAI

An AI trip planner: describe the trip you want and get a day-by-day itinerary with activities,
a realistic budget breakdown, packing tips, and local advice — then track it from your dashboard.

Built with **Express 5**, **PostgreSQL (Neon) / SQLite**, **Passport (Google OAuth)**, and the
**Google Gemini API**, with a hand-rolled dark UI on Bootstrap 5.

---

## Quick start

```bash
npm install
cp .env.example .env      # then fill in your keys (Windows: copy .env.example .env)
npm start
```

Open <http://localhost:3000>.

**No API keys?** Click **Continue as Demo Traveler** on the login page. Everything works offline —
itineraries fall back to a deterministic template generator, and suggestions fall back to a curated list.

---

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | No | Google AI Studio key. Without it, template itineraries are used. |
| `GEMINI_MODEL` | No | Defaults to `gemini-3.5-flash`. Falls back automatically to `gemini-3.1-flash-lite` if the model is retired, overloaded, or times out. |
| `GOOGLE_CLIENT_ID` | No | Enables “Continue with Google”. |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth secret. |
| `SESSION_SECRET` | Yes | Signing secret for session cookies. |
| `PORT` | No | Defaults to `3000`. |
| `BASE_URL` | No | Public origin, used to build the OAuth callback. Defaults to `http://localhost:${PORT}`. |
| `DATABASE_URL` | No | PostgreSQL connection string. When set, the app uses Postgres instead of the local SQLite file. |

Google OAuth redirect URI to register: `${BASE_URL}/auth/google/callback`.

---

## Deploying to Vercel

The repo is Vercel-ready: `api/index.js` exports the Express app and `vercel.json` routes every
path to it.

1. **Database.** Vercel's filesystem is read-only and ephemeral, so SQLite cannot persist there.
   Install a Postgres database from the Vercel Marketplace (Neon). It injects `DATABASE_URL` into
   the project automatically.
2. **Environment variables** (Project → Settings → Environment Variables):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Added by the Neon integration |
   | `GEMINI_API_KEY` | Your AI Studio key |
   | `SESSION_SECRET` | Any long random string |
   | `BASE_URL` | `https://<your-project>.vercel.app` |

3. **Deploy:**

   ```bash
   npm i -g vercel
   vercel link
   vercel deploy --prod
   ```

The schema is created automatically on the first request (both backends). Sessions are stored in
Postgres via `connect-pg-simple`, so logins survive cold starts. `GET /healthz` confirms storage is
reachable and reports which backend is active.

Local development is unchanged: with no `DATABASE_URL`, the app uses `tripplanner.db` and the
in-memory session store.

> The demo account is shared — everyone who clicks **Continue as Demo Traveler** sees the same
> trips. Disable `/auth/demo-login` for a real multi-user deployment.

---

## Enabling Google sign-in

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create (or select) a project.
2. Configure the **OAuth consent screen** (External). While the app is in *Testing*, add your own
   Google account under **Test users**.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
4. Add this **Authorized redirect URI** (it must match exactly):

   ```
   http://localhost:3000/auth/google/callback
   ```

5. Copy the generated values into `.env`:

   ```env
   GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
   BASE_URL=http://localhost:3000
   ```

6. Restart the server. The Google button on `/login.html` enables itself automatically.

The server validates the credential *format* at boot (`*.apps.googleusercontent.com` + `GOCSPX-…`)
and refuses to register the strategy otherwise, so placeholder values can never bounce users to a
Google error page. `GET /auth/providers` reports whether Google is enabled and which redirect URI
to register.

If Google shows **redirect_uri_mismatch**, the URI in the console does not exactly match
`${BASE_URL}/auth/google/callback` (check for `127.0.0.1` vs `localhost`, trailing slashes, or a
different port).

---

## Scripts

| Command | Description |
| --- | --- |
| `npm start` | Start the server on `PORT`. |
| `npm run dev` | Start with `node --watch` for auto-restart. |

The SQLite database (`tripplanner.db`) and its tables are created automatically on first start.

---

## Project structure

```
trip planner/
├── server.js              Express app: middleware, sessions, passport, routes, 404/error handlers
├── config/passport.js     Google strategy + serialization (skipped when OAuth is unconfigured)
├── db/database.js         SQLite connection, schema, indexes
├── routes/
│   ├── auth.js            Google OAuth, demo login, /auth/status, /auth/me, logout
│   └── trips.js           Itinerary generation, trips, activities, suggestions, places, preferences
├── services/gemini.js     Prompting, JSON recovery, and offline fallbacks
└── public/
    ├── index.html         Marketing landing page
    ├── login.html         Sign-in (Google or demo)
    ├── dashboard.html     SPA shell with all app views
    ├── 404.html
    ├── css/style.css      Design system + component styles
    ├── js/app.js          Fetch helper, auth probe, toasts, formatters
    └── js/dashboard.js    Hash router, view rendering, form handlers
```

The dashboard is a small hash-based SPA: `#overview`, `#plan`, `#trips`, `#trip/<id>`,
`#suggestions`, `#saved`, `#preferences`.

---

## API

All `/api/trips` routes require a session. Errors are JSON: `{ "error": "..." }`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/auth/status` | Public probe → `{ authenticated, user }`. |
| `GET` | `/auth/me` | Current user + preferences (401 when signed out). |
| `POST` | `/auth/demo-login` | Create/sign in the demo account. |
| `GET` | `/auth/demo-login` | Same, then redirect to the dashboard. |
| `GET` | `/auth/logout` | Destroy the session. |
| `POST` | `/api/trips/generate` | Generate + persist an itinerary. |
| `POST` | `/api/trips/:id/regenerate` | Rebuild an existing itinerary with fresh places. |
| `GET` | `/api/trips` | List the user's trips. |
| `GET` | `/api/trips/:id` | One trip plus its activities. |
| `PATCH` | `/api/trips/:id/status` | `planned` \| `ongoing` \| `completed`. |
| `DELETE` | `/api/trips/:id` | Delete a trip (cascades to activities). |
| `PATCH` | `/api/trips/activity/:id/toggle` | Tick/untick an activity (ownership-checked). |
| `POST` | `/api/trips/suggestions` | Destination ideas for a mood/group/budget/season. |
| `GET` | `/api/trips/stats/dashboard` | Counters, recent trips, top destinations. |
| `POST` | `/api/trips/places/save` | Save a place to the wishlist. |
| `GET` | `/api/trips/places/saved` | List saved places. |
| `DELETE` | `/api/trips/places/:id` | Remove a saved place. |
| `PUT` | `/api/trips/preferences` | Upsert travel preferences. |

### `POST /api/trips/generate`

```json
{
  "destination": "Lisbon, Portugal",
  "duration": 4,
  "mood": "foodie",
  "groupType": "couple",
  "budget": "medium",
  "interests": ["food", "photography"],
  "startDate": "2026-11-10",
  "endDate": "2026-11-14",
  "notes": "Vegetarian friendly please"
}
```

Returns `{ success, tripId, itinerary, aiGenerated, warning }`. Activity names are real, named
places for the destination — the prompt explicitly forbids generic slots like "Breakfast in Lisbon"
or "Morning Exploration", and every response is validated for generic names, duplicate places and
missing addresses. A failed validation triggers one automatic rewrite; if the model is completely
unreachable the response has `aiGenerated: false` and a varied starter outline is stored instead, and
the UI flags it.

### `POST /api/trips/:id/regenerate`

Rebuilds an existing trip in place from its stored destination, duration, mood, group type, budget
and interests. Previously used places are passed to the model so the new plan suggests different
ones, and its activity rows (and checkmarks) are replaced. Returns the same shape as `/generate`.

---

## Before deploying

This project is set up for local development. For a real deployment you should:

1. Replace the default `express-session` MemoryStore with a persistent store (SQLite, Redis, …).
2. Set `cookie.secure = true`, serve over HTTPS, and add `app.set('trust proxy', 1)`.
3. Add rate limiting on `/api/trips/generate` and `/auth/demo-login`.
4. Disable the demo login route (or gate it behind an env flag).
5. Store the session secret in your platform's secret manager, not `.env`.
