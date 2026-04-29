# Overview 

BruchinDB is a senior capstone project that turns Dr. Geoffrey Morse's seed beetle research database into a searchable web-based platform. The goal is to make high-value entomological data more accessible to researchers, museum curators, natural resource managers, and other specialists while preserving a read-only public interface for the underlying scientific records.

The project was developed by Lucca Sebastiani, Mikey Schneider, Jordan Bayon, and Jake Bayon in collaboration with Dr. Geoffrey Morse from the USD Biology Department.

Live site: `https://bruchindb.org`

## Project Background

Over several decades, Dr. Morse built a relational FileMaker database focused on seed beetles (Bruchinae). His source database includes:

- taxonomic data
- specimen collection records from more than 330,000 specimens
- host plant associations
- literature citations
- many georeferenced localities
- high-resolution images for nearly all species in the group, roughly 1,800 species

This repository contains the web application layer that exposes that information through a public-facing interface without allowing open write access to the research database.

## Goals

- Make seed beetle data easier to search, browse, and understand on the web
- Support research, curation, conservation, and education workflows
- Keep the public platform read-only while preserving admin review of contributed data
- Provide map-based access to locality data and species distributions
- Create a foundation that can be extended as the database grows

## Current Features

This repository currently includes the following major pieces:

- Search page for browsing species by scientific name, tribe, location, host plant, and image availability
- Species and Specimen detail views
- Map page with clustered specimen localities and a bounding-box workflow that links map searches back to the search page
- Submit Data page for contributor uploads and metadata collection
- About, Welcome, and Learn style pages for site context and onboarding
- a Cloudflare Worker proxy that sits in front of FileMaker and caches API responses
- a small Flask backend for file uploads and submission email notifications

## Tech Stack

- Frontend: static HTML, CSS, and JavaScript
- Mapping: MapLibre GL JS
- Upload backend: Flask + flask-cors
- Data proxy: Cloudflare Workers
- Database/access layer: FileMaker Data API behind a worker proxy
- Local tooling/config: Supabase config is included for local/project infrastructure work

## Repository Layout

```text
Frontend/
  about-page/
  data-submission-page/
  loading-page/
  login-page/
  map-page/
  search-page/
  shared/
backend/
  app.py
  uploads/
cloudflare-worker/
  src/index.js
Data/
  *.csv
supabase/
fetch-locations.py
```

## How It Works

The frontend calls the endpoint defined in [Frontend/shared/config.js](Frontend/shared/config.js), which currently points to a deployed Cloudflare Worker. That worker authenticates with FileMaker, forwards approved requests, strips or reshapes some response fields, proxies image access, and caches common queries to reduce load on the source database.

For contributor submissions, the Submit Data page can send files and contact information to the Flask app in [backend/app.py](backend/app.py). Uploaded files are stored locally in backend/uploads/, then attached to an email notification for review.

## Getting Started

### 1. Serve the frontend

From the repository root:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/Frontend/welcome-page/index.html
```

### 2. Point the frontend to an API

Edit [Frontend/shared/config.js](Frontend/shared/config.js) and set `fileMakerUrl` to the deployed proxy you want to use.

The current file expects a Cloudflare Worker endpoint such as:

```js
export const CONFIG = {
  fileMakerUrl: 'https://fm-proxy.bruchindb.workers.dev',
};
```

### 3. Run the Flask upload service

Create an environment and install the Python dependencies used by `backend/app.py`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install flask flask-cors werkzeug
```

Set the email app password used for submission notifications:

```bash
export BRUCHINDB_EMAIL_APP_PASSWORD='your-app-password'
```

Start the server:

```bash
python backend/app.py
```

By default, the upload service runs on:

```text
http://localhost:5000
```

### 4. Run or deploy the Cloudflare Worker

Inside `cloudflare-worker/`:

```bash
npm install
npm run dev
```

For deployment details and secret setup, see [cloudflare-worker/DEPLOY.md](cloudflare-worker/DEPLOY.md).

## Data and Utility Scripts

- [fetch-locations.py](fetch-locations.py) pulls locality data through the proxy and builds `Frontend/shared/locations.json` for autocomplete and filtering.
- The `Data/` folder contains CSV files related to the project data model and exports used during development.
- The live web app is designed around external FileMaker-backed data rather than only the CSV files stored in this repository.

## Project Status

BruchinDB is an active student project and a working prototype. 

## Capstone Context

The original project plan centered on helping the following groups access seed beetle data more effectively:

- museum curators
- natural resource managers
- entomologists and biodiversity researchers
- seed beetle specialists
- agriculture and conservation stakeholders

The design direction emphasized:

- read-only public access to the research database
- secure admin control over changes and submissions
- faster discovery through search and mapping
- better documentation and long-term maintainability

## Acknowledgments

- Dr. Geoffrey Morse for the scientific data, domain expertise, and project sponsorship
- the USD Biology Department for the research context behind the platform
- the CS Senior Capstone Design 2025-26 course team and contributors supporting the project
