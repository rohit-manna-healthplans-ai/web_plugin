# Push this backend to GitHub (e.g. Railway auto-deploy)

This repo is safe for **public** GitHub: secrets live in **Railway Variables** / local `.env` only (see `.env.example`).

## One-time: connect your PC to the GitHub repo

From the `discovery-ai-backend-main` folder:

```bash
# Add the official backend repo (use HTTPS or SSH)
git remote add discovery-backend https://github.com/Sousannah-healthplans/discovery-ai-backend.git

# Fetch what is on GitHub
git fetch discovery-backend

# Option A — replace GitHub main with your local main (you own the repo; backs up remote history)
# git push discovery-backend main --force

# Option B — merge remote with your history (if you need both histories)
# git merge discovery-backend/main --allow-unrelated-histories
# resolve conflicts, then:
# git push discovery-backend main
```

If you already use another remote name (e.g. `origin`), use that name instead of `discovery-backend`.

## Railway

In [Railway](https://railway.app) → your service → **Variables**, set at least:

- `MONGO_URI` — Atlas connection string  
- `JWT_SECRET` — random string  
- `EXTENSION_API_KEY` — same key the browser extension uses  
- `AZURE_STORAGE_CONNECTION_STRING` — optional, for screenshot blobs  
- `MONGO_DBNAME` — optional (default `claims_demo`)

`PORT` is set automatically by Railway.

Every **push to `main`** on the connected GitHub repo triggers a new deploy (if auto-deploy is enabled).
