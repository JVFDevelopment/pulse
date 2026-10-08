// Small helpers for Roblox's public web APIs, shared by the functions.

export async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

export async function universeFor(placeId) {
  try {
    const { universeId } = await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    return universeId ?? null;
  } catch {
    return null;
  }
}
