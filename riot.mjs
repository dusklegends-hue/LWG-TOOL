/*
LWG Team Tool — Riot layer
--------------------------
Everything that talks to Riot (through the LWG proxy worker) plus the shaping around it,
with no DOM in sight. The web app imports it; so does strategy.mjs from Node, which is the
point: a lobby can be scouted from the tab or from a chat window and produce the same data.
*/

export const RIOT_PROXY_BASE = "https://lwg-riot-proxy.dusklegends-lwg.workers.dev";

// Scouting fans out over a whole lobby at once, so it pulls far fewer matches per player
// than the Stats tab does — ten players at STATS_MATCH_COUNT would blow the Riot rate limit.
export const SCOUT_MATCH_COUNT = 8;

export const ROLE_DISPLAY_NAMES = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  BOTTOM: "ADC",
  UTILITY: "Support",
  OTHER: "Other/ARAM",
};

export function titleCase(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function riotErrorMessage(body, fallback) {
  if (typeof body?.status?.message === "string") return body.status.message;
  if (typeof body?.error === "string") return body.error;
  return fallback;
}

export function splitRiotId(riotId) {
  const idx = riotId.lastIndexOf("#");
  if (idx === -1) return [null, null];
  return [riotId.slice(0, idx).trim(), riotId.slice(idx + 1).trim()];
}

export function aggregateStats(matches, puuid) {
  let games = 0;
  let wins = 0;
  let losses = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  const roles = {};
  const champions = {};

  matches.forEach((match) => {
    if (!match || !match.info) return;
    const me = match.info.participants.find((p) => p.puuid === puuid);
    if (!me) return;

    games++;
    if (me.win) wins++;
    else losses++;
    kills += me.kills;
    deaths += me.deaths;
    assists += me.assists;

    const role = me.teamPosition || "OTHER";
    roles[role] = (roles[role] || 0) + 1;

    const champKey = me.championName;
    if (!champions[champKey]) champions[champKey] = { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
    champions[champKey].games++;
    if (me.win) champions[champKey].wins++;
    champions[champKey].kills += me.kills;
    champions[champKey].deaths += me.deaths;
    champions[champKey].assists += me.assists;
  });

  return { games, wins, losses, kills, deaths, assists, roles, champions };
}

/* ---------- op.gg multi-search ---------- */

// These links come in several shapes and people also just paste a list of Riot IDs, so this
// accepts all of them and returns whatever it can make sense of:
//   https://op.gg/lol/multisearch/na?summoners=Name%23TAG,Other%23TAG
//   https://www.op.gg/multisearch/euw?summoners=...
//   https://na.op.gg/multi/query=name1%2Cname2      (legacy — no tags in it)
//   Name#TAG, Other#TAG                             (raw paste)
export function parseOpggMultiSearch(raw) {
  const text = (raw || "").trim();
  if (!text) return { region: null, players: [] };

  let region = null;
  let list = text;

  if (/op\.gg/i.test(text)) {
    try {
      const url = new URL(text.startsWith("http") ? text : `https://${text}`);

      const hostParts = url.hostname.split(".");
      if (hostParts.length > 2 && hostParts[0] !== "www") region = hostParts[0];

      const segments = url.pathname.split("/").filter(Boolean);
      const multiIndex = segments.findIndex((s) => s === "multisearch" || s === "multi");
      if (multiIndex !== -1 && segments[multiIndex + 1] && !segments[multiIndex + 1].includes("query=")) {
        region = segments[multiIndex + 1];
      }

      // The legacy form hides the names in the path ("/multi/query=a%2Cb"), not a query string.
      const pathQuery = url.pathname.match(/query=(.*)$/);
      list = url.searchParams.get("summoners") || url.searchParams.get("query") || (pathQuery ? pathQuery[1] : "");
    } catch (err) {
      console.warn("Could not parse that op.gg link, falling back to reading it as a plain list", err);
    }
  }

  let decoded = list;
  try {
    decoded = decodeURIComponent(list);
  } catch {
    // A stray % in a summoner name makes decoding throw — the raw text is still usable.
  }

  const players = decoded
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [gameName, tagLine] = splitRiotId(entry);
      return gameName ? { gameName, tagLine } : { gameName: entry, tagLine: null };
    });

  return { region: region ? region.toLowerCase() : null, players };
}

/* ---------- Scouting ---------- */

// One match as the numbers a draft actually turns on. op.gg shows these per game; the match
// record carries them, so the scout keeps them rather than stopping at win/loss and KDA.
// Damage share matters more than raw damage: it says whether they are the carry or the escort.
function summarizeMatch(match, puuid) {
  const me = match?.info?.participants?.find((p) => p.puuid === puuid);
  if (!me) return null;

  const minutes = Math.max(1, (match.info.gameDuration || 0) / 60);
  const damage = me.totalDamageDealtToChampions || 0;
  const teamDamage = match.info.participants
    .filter((p) => p.teamId === me.teamId)
    .reduce((sum, p) => sum + (p.totalDamageDealtToChampions || 0), 0);
  const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);

  return {
    champion: me.championName,
    role: ROLE_DISPLAY_NAMES[me.teamPosition] || titleCase(me.teamPosition || "other"),
    kills: me.kills,
    deaths: me.deaths,
    assists: me.assists,
    damage,
    dpm: Math.round(damage / minutes),
    damageShare: teamDamage > 0 ? Math.round((damage / teamDamage) * 100) : 0,
    csPerMin: Number((cs / minutes).toFixed(1)),
    visionScore: me.visionScore ?? 0,
    durationMin: Math.round(minutes),
    win: Boolean(me.win),
    queueId: match.info.queueId ?? null,
  };
}

function averageBy(rows, key) {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((sum, r) => sum + (r[key] || 0), 0) / rows.length);
}

function summarizeRankedEntry(entry) {
  return {
    tier: `${titleCase(entry.tier)} ${entry.rank}`,
    lp: entry.leaguePoints,
    wins: entry.wins,
    losses: entry.losses,
  };
}

// roster is the shared player list ([{ name, riotId }]) so a scouted account that belongs to
// one of ours is labelled as such instead of reading as a stranger.
export async function scoutOnePlayer(player, roster = []) {
  const riotId = player.tagLine ? `${player.gameName}#${player.tagLine}` : player.gameName;
  const matched = roster.find((p) => (p.riotId || "").toLowerCase() === riotId.toLowerCase());
  const base = { riotId, matchedPersonName: matched ? matched.name : null };

  if (!player.tagLine) {
    return { ...base, error: "No #tag in the link — Riot needs Name#TAG to look this player up." };
  }

  try {
    const accountRes = await fetch(
      `${RIOT_PROXY_BASE}/account?gameName=${encodeURIComponent(player.gameName)}&tagLine=${encodeURIComponent(player.tagLine)}`
    );
    const accountData = await accountRes.json();
    if (!accountRes.ok) throw new Error(riotErrorMessage(accountData, "Could not find that Riot ID"));
    const puuid = accountData.puuid;

    const [rankedRes, matchIdsRes] = await Promise.all([
      fetch(`${RIOT_PROXY_BASE}/ranked?puuid=${puuid}`),
      fetch(`${RIOT_PROXY_BASE}/matches?puuid=${puuid}&count=${SCOUT_MATCH_COUNT}`),
    ]);
    const ranked = await rankedRes.json();
    const matchIds = await matchIdsRes.json();
    if (!rankedRes.ok) throw new Error(riotErrorMessage(ranked, "Could not load ranked stats"));
    if (!matchIdsRes.ok) throw new Error(riotErrorMessage(matchIds, "Could not load match history"));

    const matches = await Promise.all(
      (Array.isArray(matchIds) ? matchIds : []).map((id) => fetch(`${RIOT_PROXY_BASE}/match/${id}`).then((r) => r.json()))
    );
    const stats = aggregateStats(matches, puuid);
    const rows = matches.map((m) => summarizeMatch(m, puuid)).filter(Boolean);

    const rankedList = Array.isArray(ranked) ? ranked : [];
    const solo = rankedList.find((r) => r.queueType === "RANKED_SOLO_5x5");
    const flex = rankedList.find((r) => r.queueType === "RANKED_FLEX_SR");

    return {
      ...base,
      solo: solo ? summarizeRankedEntry(solo) : null,
      flex: flex ? summarizeRankedEntry(flex) : null,
      recent: {
        games: stats.games,
        wins: stats.wins,
        losses: stats.losses,
        kda: stats.deaths > 0 ? (stats.kills + stats.assists) / stats.deaths : stats.kills + stats.assists,
        roles: Object.entries(stats.roles)
          .sort((a, b) => b[1] - a[1])
          .map(([role, games]) => ({ role: ROLE_DISPLAY_NAMES[role] || titleCase(role), games })),
        champions: Object.entries(stats.champions)
          .sort((a, b) => b[1].games - a[1].games)
          .slice(0, 5)
          .map(([name, c]) => {
            const onChamp = rows.filter((r) => r.champion === name);
            return {
              name,
              games: c.games,
              wins: c.wins,
              kda: c.deaths > 0 ? (c.kills + c.assists) / c.deaths : c.kills + c.assists,
              dpm: averageBy(onChamp, "dpm"),
              damageShare: averageBy(onChamp, "damageShare"),
              csPerMin: onChamp.length ? Number((onChamp.reduce((s, r) => s + r.csPerMin, 0) / onChamp.length).toFixed(1)) : 0,
            };
          }),
        // Kept game by game as well as averaged: a lobby that just lost four in a row on the
        // same champion is a different draft problem than one with a flat 50% over a season.
        matches: rows,
      },
    };
  } catch (err) {
    // One unreachable player must not sink the scout, and the reason travels on the record
    // itself — a bare stack trace per player buries the report that follows.
    const message = err.message || "Lookup failed.";
    console.warn(`Scouting ${riotId} failed: ${message}`);
    return { ...base, error: message };
  }
}

export async function scoutLobby(opggUrl, roster = []) {
  const parsed = parseOpggMultiSearch(opggUrl);
  if (parsed.players.length === 0) throw new Error("No players found in that op.gg link.");

  const players = [];
  // Sequential on purpose: a whole lobby looked up in parallel trips Riot's rate limit, and a
  // scout that half-fails is worse than one that takes a few extra seconds.
  for (const player of parsed.players) {
    players.push(await scoutOnePlayer(player, roster));
  }

  return {
    region: parsed.region,
    matchesPerPlayer: SCOUT_MATCH_COUNT,
    fetchedAt: new Date().toISOString(),
    players,
  };
}

// One scouted player as a single line of plain text — used by the tab's "Copy for Claude"
// button and by the CLI, so both describe a lobby the same way.
export function formatScoutedPlayer(p) {
  const who = p.matchedPersonName ? `${p.riotId} [roster: ${p.matchedPersonName}]` : p.riotId;
  if (p.error) return `${who} — lookup failed: ${p.error}`;

  const rank = p.solo ? `${p.solo.tier} ${p.solo.lp}LP ${p.solo.wins}W/${p.solo.losses}L` : "Unranked solo";
  const flex = p.flex ? `, Flex ${p.flex.tier}` : "";
  const roles = (p.recent?.roles || []).map((r) => `${r.role}×${r.games}`).join("/") || "no recent games";
  const champs =
    (p.recent?.champions || [])
      .map((c) => `${c.name} ${c.wins}/${c.games} ${c.kda.toFixed(1)}kda ${c.dpm}dpm ${c.damageShare}%dmg`)
      .join(", ") || "none";
  return `${who} — ${rank}${flex} · ${roles} · ${champs}`;
}

// The game-by-game lines, for when the averages hide the story (a losing streak, one
// off-role game, a smurf's first week). Used by the CLI's `get`, not by the tab's cards.
export function formatScoutedPlayerMatches(p) {
  return (p.recent?.matches || []).map(
    (m) =>
      `${m.win ? "W" : "L"} ${m.champion} (${m.role}) ${m.kills}/${m.deaths}/${m.assists} · ` +
      `${m.dpm}dpm ${m.damageShare}%dmg ${m.csPerMin}cs/m vis${m.visionScore} · ${m.durationMin}min`
  );
}
