// Scheduled every 10 minutes: stores the player count of the dashboard's default games and
// every recently tracked game, so history keeps building while nobody has the page open.
import { getJson, universeFor } from "../lib/roblox.mjs";
import { openStore, record, watched } from "../lib/history.mjs";

const DEFAULT_PLACES = ["920587237", "2753915549", "4924922222", "6516141723"];
const BATCH = 30;

export default async () => {
  const store = openStore();
  if (!store) return;
  const now = Date.now();
  const defaults = (await Promise.all(DEFAULT_PLACES.map(universeFor))).filter(Boolean);
  const ids = [...new Set([...defaults, ...(await watched(store, now))])];

  for (let i = 0; i < ids.length; i += BATCH) {
    const { data } = await getJson(`https://games.roblox.com/v1/games?universeIds=${ids.slice(i, i + BATCH).join(",")}`);
    await Promise.all(data.map((g) => record(store, g.id, g.playing ?? 0, now)));
  }
};

export const config = { schedule: "*/10 * * * *" };
