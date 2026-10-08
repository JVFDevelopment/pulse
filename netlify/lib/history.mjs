// Player-count history kept in Netlify Blobs, so a first-time visitor sees a 24-hour chart
// instead of only the samples their own browser has collected.
//
// Keys: `u/<universeId>` -> [[timeMs, playing], ...] (oldest first)
//       `watch`          -> { [universeId]: lastRequestedMs }
import { getStore } from "@netlify/blobs";

export const SAMPLE_MS = 10 * 60 * 1000; // one stored sample per ~10 minutes
export const KEEP_MS = 24 * 60 * 60 * 1000; // for the last 24 hours
const WATCH_MS = 7 * 24 * 60 * 60 * 1000; // keep recording games someone tracked this week
const MAX_WATCHED = 60;

// null when there's no Blobs context (e.g. running the function outside Netlify)
export function openStore() {
  try {
    return getStore("ccu");
  } catch {
    return null;
  }
}

// The points with `playing` appended, or null if the newest sample is still fresh.
export function addSample(points, playing, now) {
  const last = points[points.length - 1];
  if (last && now - last[0] < SAMPLE_MS - 60_000) return null;
  return [...points.filter(([t]) => now - t < KEEP_MS), [now, playing]];
}

// Store a sample (if one is due) and return the game's history.
export async function record(store, universeId, playing, now = Date.now()) {
  const points = (await store.get(`u/${universeId}`, { type: "json" })) ?? [];
  const next = addSample(points, playing, now);
  if (next) await store.setJSON(`u/${universeId}`, next);
  return next ?? points;
}

export function prune(watch, now) {
  return Object.fromEntries(
    Object.entries(watch)
      .filter(([, t]) => now - t < WATCH_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_WATCHED)
  );
}

// Remember which games people track so the scheduled job keeps recording them.
// Each game's timestamp is refreshed at most hourly, to keep writes rare.
export async function touchWatch(store, universeIds, now = Date.now()) {
  const watch = (await store.get("watch", { type: "json" })) ?? {};
  const stale = universeIds.filter((id) => !watch[id] || now - watch[id] > 60 * 60 * 1000);
  if (!stale.length) return;
  for (const id of stale) watch[id] = now;
  await store.setJSON("watch", prune(watch, now));
}

export async function watched(store, now = Date.now()) {
  return Object.keys(prune((await store.get("watch", { type: "json" })) ?? {}, now)).map(Number);
}
