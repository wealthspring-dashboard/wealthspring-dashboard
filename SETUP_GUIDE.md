# Setup Guide -- Wealthspring Dashboard

Practical reference for getting this dashboard running or reconfigured from scratch (e.g. after a credential rotation, or setting up a new environment). For architecture, design decisions, and every bug we've hit and fixed along the way, see the project history -- this file is just the "how," not the "why."

## 1. What This Is

Wealthspring Financial Services' internal CEO executive dashboard. Pulls live data from QuickBooks Online and QuickBooks Time. Single shared team password, no individual logins. Deployed on Vercel, auto-deploying from this repo's `main` branch.

## 2. Environment Variables

See `env.example` for the full list of variable names this app expects. Set real values under Vercel -> this project -> Settings -> Environment Variables. **Changing an environment variable requires a redeploy to take effect** -- it does not apply retroactively to an already-running deployment.

Core (needed for the dashboard to load and let you log in at all):
- `DASHBOARD_PASSWORD` -- the shared team login password
- `SESSION_SECRET` -- long random string, signs session cookies
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` -- from the connected Upstash Redis database (Vercel: Storage -> Marketplace Database Providers)

QuickBooks Online (Settings -> Integrations -> QuickBooks Online in the app, or set up fresh via developer.intuit.com):
- `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT`, `QBO_REDIRECT_URI`

QuickBooks Time (a separate product from QuickBooks Online -- separate OAuth server, separate credentials, set up via the QuickBooks Time API Add-On page, not developer.intuit.com):
- `QBTIME_CLIENT_ID`, `QBTIME_CLIENT_SECRET`, `QBTIME_REDIRECT_URI`
- `QBTIME_SEED_ACCESS_TOKEN` / `QBTIME_TOKEN_EXPIRES_AT` only apply if using the legacy manual-token connection method instead of the OAuth flow (Settings -> Integrations -> QuickBooks Time toggle is the current, preferred path -- it auto-renews, the manual method doesn't).

## 3. Vercel Configuration Checklist

- Deployment Protection must stay **off** (Settings -> Deployment Protection), or the app becomes unreachable without a separate Vercel login.
- Confirm auto-deploy is wired to this repo's `main` branch.

## 4. Uploading Changes (no local dev environment, no git CLI)

Everything is done through GitHub's web interface:
- **Replacing an existing file**: navigate to its exact folder, "Add file -> Upload files," drag it in -- the filename must match exactly or it creates a duplicate instead of replacing.
- **Adding a genuinely new file**: "Add file -> Create new file," type the full path (including any new folder) into the filename field -- typing a `/` auto-creates the folder.
- Always double-check you're in the correct folder before creating a new file -- creating it while still inside the wrong parent directory nests it incorrectly and breaks import paths.
- After any upload, check Vercel's Deployments tab shows **Ready**, not **Error**, before assuming the change is live.

## 5. Reconnecting an Integration

If QuickBooks or QuickBooks Time ever needs to be reconnected (expired credentials, revoked access, etc.), it's a Settings-panel action inside the app itself -- toggle the integration off then on, which walks through the OAuth flow again. No file changes needed for a routine reconnect.
