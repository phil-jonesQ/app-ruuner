<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1h0i6xb46tOylR5P2nEQVW7LcCdaX7RHs

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

Server (backend) support
------------------------

The repository now includes a small server (Express + socket.io) which powers the runner UI and a tiny persistent stats store. To run it locally:

The optional SportAPI proxy requires `SPORTAPI_API_KEY` in the app-runner server's environment. Keep this key on the server; do not add it to the teletext app's Vite environment or client bundle. For Docker Compose, set the variable in the deployment environment before starting or recreating the runner container. The proxy endpoint is `/api/sportapi/fixtures/date/:date`, only serves the current London calendar date, and caches responses for 60 seconds to limit provider usage. Rebuild and redeploy the app-runner itself to install this proxy; uploading a game ZIP alone does not update its server.

```bash
# install dependencies (root)
npm install

# start just the server
npm run server

# or run the full frontend dev server
npm run dev
```

Once running, the UI shows a live "Online" count and a Version badge (starts at 1.0.1). Launches and ratings are recorded on the server and displayed live in the dashboard.

Integration tests / smoke tests
--------------------------------

There are two quick scripts to verify functionality once the server is running:

```bash
# lightweight smoke test (calls endpoints)
npm run smoke-test

# integration test (exercises socket.io + APIs)
npm run integration-test
```
