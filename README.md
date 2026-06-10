# Kaboo PWA

A static progressive web app for Kaboo, also known as Window. It includes the title/options flow, singleplayer AI, lobby/join screens, installable PWA metadata, offline caching, card memory, snapping, action cards, Kaboo lock-in, scoring, and replay flow.

## Run Locally

```powershell
npm run dev
```

Open the Vite URL printed in the terminal, usually `http://127.0.0.1:5173`.

## Build

```powershell
npm run build
```

The deployable files are written to `dist/`.

## Netlify Deployment

Use these Netlify settings:

- Build command: `npm run build`
- Publish directory: `dist`
- Node version: any current LTS or newer
- Redirects: already handled by `netlify.toml`

The app is static, so it deploys cleanly to Netlify without server functions.

## Multiplayer Deployment

Multiplayer uses two deploys:

1. Netlify hosts the static PWA.
2. Render hosts the WebSocket relay in `server/`.

### 1. Deploy the Relay on Render

Create a new Render Web Service from this GitHub repo.

Use these settings:

- Root directory: `server`
- Runtime: `Node`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/healthz`

Add this environment variable after you know your Netlify site URL:

```text
ALLOWED_ORIGIN=https://your-netlify-site.netlify.app
```

For the first relay deploy, you can temporarily use:

```text
ALLOWED_ORIGIN=*
```

After Render deploys, note the service URL. If Render gives:

```text
https://kaboo-relay.onrender.com
```

then the WebSocket URL is:

```text
wss://kaboo-relay.onrender.com/ws
```

### 2. Connect Netlify to the Relay

In Netlify, open the Kaboo site and add this environment variable:

```text
VITE_KABOO_RELAY_URL=wss://kaboo-relay.onrender.com/ws
```

Then trigger a new Netlify deploy. Vite bakes `VITE_` variables into the browser bundle during build, so a redeploy is required after changing this value.

### 3. Play Online

1. Open the Netlify URL.
2. Set a username in Options.
3. Click Multiplayer.
4. Host Game creates a relay lobby and 4-digit code.
5. Toggle Public if you want the lobby to appear in Join Game.
6. Friends open the same Netlify URL and join by code or public lobby.
7. Ready up and the host starts the game.

The relay owns lobby state, deck order, turn order, card visibility, ready states, Kaboo protection, snap attempts, action-card choices, scoring, and AI seats. Each browser receives a filtered view so the local player is always at the bottom and hidden cards stay hidden.

Important future hardening before a wider public launch:

- Durable persistence if a Render instance restarts.
- Reconnection into an in-progress seat after refresh.
- Rate limiting for lobby creation and snap attempts.
- Server-side timestamps for near-simultaneous snap tie-breaks.
- More exhaustive automated multiplayer tests.

## Card Art

Recommended asset pack: [`hayeah/playing-cards-assets`](https://github.com/hayeah/playing-cards-assets). Its README describes SVG and PNG playing card assets, lists an MIT license, and credits the original vector card source as public domain. The current app uses CSS-rendered cards so it works offline without downloading assets, but the `renderCard` function is the single place to swap in SVG/PNG card faces later.
