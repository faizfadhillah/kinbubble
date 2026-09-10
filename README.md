# KinBubble — interactive family tree creator

Build your family tree as living bubbles. Each person is a bubble, each family name is a coloured group, and parents, partners and children are linked. Log in, edit, search, and share with relatives.

## Features

- **Accounts** — email + password registration and login (bcrypt hashed, JWT session cookie, 30-day sessions), account settings, password change.
- **Trees** — create as many trees as you like; each has its own people and relationships.
- **Interactive graph** (D3 force layout)
  - Bubble view: people cluster into soft family "bubbles" by family name, with a legend to show/hide families.
  - Generations view: rows by generation, partners kept level.
  - Drag, zoom, pan, fit-to-screen, hover tooltips, click for details, double-click to edit.
  - Photo bubbles (photo URL), dashed ring for women, dashed border for deceased.
- **Editing** — add a parent / partner / child / sibling straight from a person's card, link existing people, edit details, delete. Cycle-safe (nobody can be their own ancestor).
- **Person details** — first/family/maiden name, nickname, gender, birth & death dates, birthplace, current location, occupation, tags, photo, free-text story.
- **Search** — by name, family name, or details (place, occupation, tags, story, dates), with field filter, live highlighting on the graph, keyboard navigation, and cross-tree search from the dashboard.
- **Sharing**
  - Invite by email as *viewer* or *editor* (they see the tree under "My trees" after logging in with that email).
  - Share links: private / anyone-with-link can view / anyone-with-link can edit — no account needed for link access. Reset the link any time.
- **Mobile friendly**, light/dark theme aware, single dependency-light Node server with SQLite (nothing else to run).

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Data lives in `./data/kinbubble.db` (SQLite) unless `DATABASE_URL` points at a Postgres server, in which case Postgres is used instead. A random `JWT_SECRET` is generated on first run and stored in `./data/.jwt_secret`.

## Run with Docker

```bash
docker compose up -d --build
```

Data persists in the `kinbubble-data` volume. In production set `JWT_SECRET` (`openssl rand -hex 32`) and put the app behind HTTPS (Caddy, nginx, Traefik, or your host's TLS). Session cookies are `Secure` when `NODE_ENV=production`; if you must run production over plain HTTP set `INSECURE_COOKIE=1`.

## Deploy

- **Vercel (serverless) + Postgres** — the repo ships `vercel.json` + `api/index.js`. Import the repo in Vercel, then in the project's *Storage* tab add a **Neon Postgres** database (free tier); it injects `DATABASE_URL` automatically. Redeploy and you're live. Set a `JWT_SECRET` env var too (otherwise one is derived from the database URL).
- **Render** — this repo includes `render.yaml`; create a new Blueprint from the repo and it deploys with a persistent disk.
- **Fly.io / Railway / a VPS** — it is a plain Docker image with a `/data` volume; any host that gives you a persistent disk works.
- **Reverse proxy** — the app trusts one proxy hop (`trust proxy`), so `X-Forwarded-*` headers from Caddy/nginx are honoured.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | — | Postgres connection string; when set, Postgres replaces SQLite |
| `DATA_DIR` | `./data` | Where the SQLite DB and secret live (SQLite mode) |
| `JWT_SECRET` | auto-generated | Signs session cookies — set explicitly in production |
| `NODE_ENV` | — | `production` enables secure cookies |
| `INSECURE_COOKIE` | — | `1` disables the `Secure` cookie flag |

## API overview

All endpoints are JSON under `/api`. Session is a httpOnly cookie; share links pass `?share=<token>` or the `X-Share-Token` header.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/register` `/login` `/logout` | `GET /api/auth/me`, `PATCH /api/auth/me` |
| GET/POST | `/api/trees` | list own + shared trees / create |
| GET/PATCH/DELETE | `/api/trees/:slug` | tree with people + relationships; owner can rename, change `share_mode` |
| POST | `/api/trees/:slug/share/rotate` | new share token |
| POST/DELETE | `/api/trees/:slug/members[/:email]` | invite / remove (`role`: viewer, editor) |
| POST/PATCH/DELETE | `/api/trees/:slug/persons[/:id]` | optional `link: {type: parent|child|spouse|sibling, person_id}` on create |
| POST/DELETE | `/api/trees/:slug/relationships[/:id]` | `type`: `parent` (from = parent, to = child) or `spouse` |
| GET | `/api/search?q=&field=any|name|family|details&tree=slug` | omit `tree` to search every tree you can access |

## Stack

Node 18+, Express 5, SQLite (better-sqlite3) or Postgres (pg), bcryptjs, jsonwebtoken · vanilla JS + D3 v7 (vendored) on the front end. No build step.

## License

MIT
