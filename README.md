# Pulse

**Live analytics for Roblox games.** Track up to six games side by side, including concurrent players, visits, favorites, like ratio and update history, and watch player counts move in real time.

## Features

- **Live player counts**, polled every 30 seconds, with a change indicator on each card
- **Multi-game chart**: a hand-drawn canvas line chart with hover crosshair and tooltip, and no chart library
- **Per-game sparklines** and like/dislike rating bars
- **Share of players**: how the tracked games split the combined audience
- **Paste anything**: a full game URL (`roblox.com/games/…`) or a bare place ID
- **Shareable**: the tracked games are kept in the URL hash, so a link restores the same dashboard
- **Remembers**: up to 3 hours of samples are saved locally, so a refresh keeps your chart

## How it works

Roblox's public web APIs don't send CORS headers, so a browser can't call them directly. A single serverless function ([`netlify/functions/games.mjs`](netlify/functions/games.mjs)) handles that:

1. Resolves each place ID to its universe ID
2. Fetches game details, votes and icons in parallel, batched into one request each
3. Merges them into one compact response, cached for 15 seconds at the edge

The frontend is plain HTML, CSS and JavaScript modules with no build step.

```
public/                  static site
netlify/functions/       /api/games proxy
```

## Deploy

Connect the repo to Netlify. `netlify.toml` already sets the publish folder and functions directory, so no build settings are needed.

Not affiliated with Roblox Corporation.
