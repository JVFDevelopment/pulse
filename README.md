# Pulse

**Live analytics for Roblox games.** Track up to six games side by side, including concurrent players, visits, favorites, like ratio and update history, and watch player counts move in real time, with 24 hours of history from the first visit.

## Features

- **Live player counts**, polled every 30 seconds, with the change over the last hour on each card
- **24-hour history**: recorded server-side every 10 minutes, so the chart is full from the first visit
- **Multi-game chart**: a hand-drawn canvas chart with smooth curves, 1H / 6H / 24H ranges, a hover crosshair and tooltip, and legend toggles, with no chart library
- **Per-game sparklines** with range peak and low, plus like/dislike rating bars
- **Share of players**: how the tracked games split the combined audience
- **Paste anything**: a full game URL (`roblox.com/games/…`) or a bare place ID
- **Shareable**: the tracked games are kept in the URL hash, so a link restores the same dashboard

## How it works

Roblox's public web APIs don't send CORS headers, so a browser can't call them directly. A serverless function ([`netlify/functions/games.mjs`](netlify/functions/games.mjs)) handles that:

1. Resolves each place ID to its universe ID
2. Fetches game details, votes and icons in parallel, batched into one request each
3. Attaches each game's stored history and merges it all into one compact response, cached for 15 seconds at the edge

History lives in [Netlify Blobs](https://docs.netlify.com/blobs/overview/) ([`netlify/lib/history.mjs`](netlify/lib/history.mjs)): one sample per game every ~10 minutes, kept for 24 hours. A scheduled function ([`netlify/functions/record.mjs`](netlify/functions/record.mjs)) records the default games and anything tracked in the last week, so history keeps building while nobody has the page open. If storage is unavailable, the dashboard still works with live data only.

The frontend is plain HTML, CSS and JavaScript modules with no build step.

```
public/                  static site
netlify/functions/       /api/games proxy + scheduled recorder
netlify/lib/             shared Roblox + history helpers
```

## Deploy

Connect the repo to Netlify. `netlify.toml` already sets the publish folder and functions directory; Netlify installs the one dependency (`@netlify/blobs`) automatically.

Not affiliated with Roblox Corporation.
