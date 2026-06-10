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

## Multiplayer Relay

Netlify does not provide long-lived WebSocket hosting from ordinary static deploys/functions, so real internet multiplayer needs a separate relay service. The clean deployment shape is:

1. Deploy this PWA to Netlify.
2. Deploy a small WebSocket relay to a platform that supports persistent sockets, such as Fly.io, Railway, Render, Cloudflare Workers Durable Objects, or PartyKit.
3. Store lobby state on the relay: lobby code, public/private flag, seats, ready states, host id, and authoritative game events.
4. Use client-sent events only as intents: `createLobby`, `joinLobby`, `ready`, `startGame`, `draw`, `swap`, `play`, `snap`, `kaboo`, `playAgain`, `leave`.
5. Have the relay validate turn order, snap windows, card visibility, deck order, and scoring. Do not trust the browser for multiplayer authority.
6. Add a Netlify environment variable for the relay URL if you introduce a build-time bundler later, or serve a small `/config.js` next to the app that assigns `window.KABOO_RELAY_URL = "wss://your-relay.example"`.

Essential multiplayer details still worth adding before a public launch:

- Reconnection and host migration if the host disconnects.
- A server-side profanity/moderation pass for usernames.
- Anti-cheat visibility rules, with per-player private messages for peeks and drawn cards.
- Server timestamps for snap tie-breaking, with the owner winning exact ties.
- Lobby expiry and rate limiting so public lobbies do not pile up.
- A short tutorial/rules panel for first-time players.

## Card Art

Recommended asset pack: [`hayeah/playing-cards-assets`](https://github.com/hayeah/playing-cards-assets). Its README describes SVG and PNG playing card assets, lists an MIT license, and credits the original vector card source as public domain. The current app uses CSS-rendered cards so it works offline without downloading assets, but the `renderCard` function is the single place to swap in SVG/PNG card faces later.
