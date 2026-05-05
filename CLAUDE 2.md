# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BruchinDB (`https://bruchindb.org`) is a read-only web platform exposing Dr. Geoffrey Morse's seed beetle (Bruchinae) research database. The frontend calls a Cloudflare Worker proxy, which authenticates with a FileMaker Server, caches responses, and strips sensitive fields before returning data.

## Commands

### Serve the frontend locally

```bash
python3 -m http.server 8000
# Open: http://localhost:8000/Frontend/welcome-page/index.html
```

### Run the Flask upload backend

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install flask flask-cors werkzeug
export BRUCHINDB_EMAIL_APP_PASSWORD='your-app-password'
python backend/app.py
# Runs on http://localhost:5000
```

### Cloudflare Worker (development and deployment)

```bash
cd cloudflare-worker
npm install
npm run dev      # local dev with wrangler
npm run deploy   # deploy to Cloudflare (wrangler deploy)
```

Set required secrets before first deploy:

```bash
wrangler secret put FM_URL
wrangler secret put FM_USER
wrangler secret put FM_PASS
```

### Rebuild locations autocomplete data

```bash
python3 fetch-locations.py
# Writes Frontend/shared/locations.json
```

## Architecture

### Request flow

```
Browser → Frontend/shared/bruchindb-api.js
        → Cloudflare Worker (fm-proxy.bruchindb.workers.dev)
        → FileMaker Data API v2
```

The single API client (`Frontend/shared/bruchindb-api.js`) wraps all FileMaker interactions. The worker URL is configured in `Frontend/shared/config.js`.

### Cloudflare Worker (`cloudflare-worker/src/index.js`)

The worker is the only component that holds FileMaker credentials. It:

- Enforces read-only access (only `_find` POST and layout GET requests pass through)
- Strips sensitive/excess fields from `Event`, `Specimen`, and `Species` responses
- Caches responses in Cloudflare Cache API (search: 24 hr, species detail: 1 hr, images: 24 hr)
- Proxies and resizes images from FileMaker's container fields (`/image/`, `/thumb/`)
- Serves a pre-aggregated locality dataset for the map page (`/localities`)
- Pre-warms caches via a cron trigger daily at 06:00 UTC (`wrangler.toml`)

FileMaker databases the worker accesses: `Species`, `Specimen`, `Event` (locality layout), `Genus`.

### Map page (`Frontend/map-page/`)

All locality data is fetched once from `/localities` (the worker aggregates ~35k records from FileMaker) and cached in `sessionStorage` for 24 hours. All map filtering (bounding box, country, tribe, species name) happens client-side on this pre-fetched dataset. The first cold load can take 1-2 minutes; subsequent loads are instant.

The bounding-box workflow encodes selected coordinates into URL params that the search page reads on load.

### Search page (`Frontend/search-page/`)

Species search (`searchSpecies()` in `bruchindb-api.js`) always scopes queries to genera belonging to the six allowed Bruchinae tribes. Location filtering queries the `Event` database first, builds an allowlist of species names, then filters the species results against it.

Detail views for species (`species.html`) and specimens (`specimen.html`) are separate HTML files in the same directory, driven by URL query params.

### Flask backend (`backend/app.py`)

Handles contributor data submissions at `POST /upload`. Saves files to `backend/uploads/` with timestamped names, then emails them to the configured receiver using Gmail SMTP SSL. The `BRUCHINDB_EMAIL_APP_PASSWORD` env var must be set.

## Key files

| File | Purpose |
|---|---|
| `Frontend/shared/config.js` | Worker endpoint URL — change this to point at a different environment |
| `Frontend/shared/bruchindb-api.js` | All FileMaker API calls; the only place `fetch` talks to the worker |
| `Frontend/shared/locations.json` | Pre-built autocomplete data for country/province/locality inputs |
| `cloudflare-worker/src/index.js` | Worker proxy, caching, image streaming, locality aggregation |
| `cloudflare-worker/wrangler.toml` | Worker name, cron schedule |
| `backend/app.py` | Flask upload + email notification service |
| `fetch-locations.py` | Script to rebuild `locations.json` from the live proxy |

## Tests

One Jest test file exists for the bounding-box helper:

```
Frontend/map-page/boundingbox-utils.test.js
```

No test runner is configured at the repo root. To run it, set up Jest in the project or run it via a local Jest installation targeting that file.
