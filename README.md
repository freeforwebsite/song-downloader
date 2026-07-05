# Stereō — Song Search & Download

## Features

- 🔍 Autocomplete search (debounced, backed by YouTube's own suggestion API)
- 🎵 Title, artist, duration, cover art per result
- ▶️ In-browser preview before downloading
- 🎚️ Quality picker — 128 / 192 / 320 kbps
- 📥 One-click download with a real progress bar (estimated from bitrate × duration, since the file is streamed/converted on the fly rather than pre-sized)
- 🕒 Recent searches, ❤️ saved favorite searches (stored in the browser via localStorage)
- 📱 Responsive layout
- 🌙 Dark / ☀️ light mode toggle
- 🌍 English / Tamil UI language toggle
- 📤 Share a search result (native share sheet on mobile, clipboard link on desktop)
- 📊 Estimated file size shown before you download
- 🚀 Server-side + client-side caching so repeat searches load instantly
- ❌ Friendly error messages instead of raw failures

## Architecture

Split in two, matching how your other projects (Telegram web player, etc.) are already deployed:

```
backend/    Express + youtubei.js + ffmpeg   -> deploy to Render
frontend/   Static HTML/CSS/JS                -> deploy to Vercel
```

This split matters because audio conversion needs a long-running Node process — Vercel's serverless functions time out too fast (10s on the free tier) for streaming + ffmpeg conversion of a full song. Render runs it as a normal persistent server instead.

## 1. Push to GitHub

```bash
cd yt-song-downloader
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

## 2. Deploy the backend to Render

1. Render dashboard -> New -> Web Service -> connect your GitHub repo.
2. Root directory: backend
3. Build command: npm install
4. Start command: npm start
5. Deploy. Copy the resulting URL (e.g. https://stereo-backend.onrender.com).

## 3. Deploy the frontend to Vercel

1. Open frontend/index.html and replace this line near the top of the <script> block:
   `: 'https://YOUR-RENDER-BACKEND.onrender.com';`
   with the Render URL from step 2.
2. Commit and push that change.
3. Vercel dashboard -> New Project -> import the same GitHub repo.
4. Root directory: frontend
5. Framework preset: Other (it's a static site, no build step needed).
6. Deploy.

## Local development

```bash
cd backend && npm install && npm start   # runs on http://localhost:3000
```

Then open frontend/index.html directly in a browser — it auto-detects localhost and points at the local backend.

## Notes

- Bot detection: the backend tries WEB -> ANDROID -> IOS -> TV Innertube clients in order, same fallback pattern as yt-mvab, in case YouTube blocks one client type.
- Progress bar accuracy: since the server streams a live ffmpeg conversion rather than a pre-sized file, the download progress is an estimate based on bitrate x duration, not a byte-exact Content-Length. It's accurate to within a few percent in practice.
- Recent/favorites/theme/language are stored in the browser's localStorage, so they're per-device, not synced across devices.
- Legal note: downloading copyrighted audio without permission may violate YouTube's Terms of Service and copyright law depending on your jurisdiction and use case — built here for personal use, same as your other projects.
