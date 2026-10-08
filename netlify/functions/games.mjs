// GET /api/games?places=920587237,1537690962
// Resolves Roblox place IDs to their universe and merges game details, votes and icons into
// one response. Roblox's public APIs don't send CORS headers, so the browser can't call them directly.

const MAX_PLACES = 6;

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function universeFor(placeId) {
  try {
    const { universeId } = await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    return universeId ?? null;
  } catch {
    return null;
  }
}

export default async (req) => {
  const places = [...new Set(
    (new URL(req.url).searchParams.get("places") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d{1,15}$/.test(s))
  )].slice(0, MAX_PLACES);

  if (!places.length) {
    return Response.json({ error: "Pass ?places= with one or more numeric place IDs." }, { status: 400 });
  }

  const universes = await Promise.all(places.map(universeFor));
  const ids = universes.filter(Boolean).join(",");
  const notFound = places.filter((_, i) => !universes[i]);

  if (!ids) return Response.json({ games: [], notFound });

  try {
    const [games, votes, icons] = await Promise.all([
      getJson(`https://games.roblox.com/v1/games?universeIds=${ids}`),
      getJson(`https://games.roblox.com/v1/games/votes?universeIds=${ids}`),
      getJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids}&size=256x256&format=Png&isCircular=false`),
    ]);
    const voteBy = new Map(votes.data.map((v) => [v.id, v]));
    const iconBy = new Map(icons.data.map((i) => [i.targetId, i.imageUrl]));

    const out = games.data.map((g) => ({
      universeId: g.id,
      placeId: g.rootPlaceId,
      name: g.name,
      creator: g.creator?.name ?? "Unknown",
      creatorVerified: !!g.creator?.hasVerifiedBadge,
      genre: g.genre_l1 || g.genre || "",
      playing: g.playing ?? 0,
      visits: g.visits ?? 0,
      favorites: g.favoritedCount ?? 0,
      maxPlayers: g.maxPlayers ?? 0,
      created: g.created,
      updated: g.updated,
      upVotes: voteBy.get(g.id)?.upVotes ?? 0,
      downVotes: voteBy.get(g.id)?.downVotes ?? 0,
      icon: iconBy.get(g.id) ?? null,
      url: `https://www.roblox.com/games/${g.rootPlaceId}`,
    }));

    return Response.json(
      { games: out, notFound, fetchedAt: new Date().toISOString() },
      { headers: { "cache-control": "public, max-age=15" } }
    );
  } catch (err) {
    return Response.json({ error: `Roblox API error: ${err.message}` }, { status: 502 });
  }
};

export const config = { path: "/api/games" };
