/*
LWG Team Tool — Riot layer
--------------------------
Everything that talks to Riot (through the LWG proxy worker) plus the shaping around it,
with no DOM in sight. The web app imports it; so does strategy.mjs from Node, which is the
point: a lobby can be scouted from the tab or from a chat window and produce the same data.

Two facts drive the design of the scouting below.

1. The proxy forwards only `count`. `queue`, `type` and `start` are ignored, so ranked games
   cannot be asked for — every recent game has to be fetched and then filtered by queueId.
2. Riot's key allows roughly 20 requests a second and 100 every two minutes. A five-player
   lobby at 30 ranked games each is 150+ fetches, which is over that budget on its own.

So requests go through a throttle, and every match is summarised once and cached by
(matchId, puuid). Matches are immutable, so a re-scout of the same lobby an hour later pays
only for the games played since.
*/

export const RIOT_PROXY_BASE = "https://lwg-riot-proxy.dusklegends-lwg.workers.dev";

// The queues a strategy should be read from. Normals, ARAM and Arena say very little about
// how someone drafts, and they were dominating the old sample.
export const RANKED_QUEUES = { 420: "solo", 440: "flex" };

// How many ranked games to poll per player, and how far back to look for them. A player who
// splits their time with ARAM needs a wider window to yield 30 ranked games; the window caps
// what one scout can cost when they never do.
export const RANKED_SAMPLE_TARGET = 30;
export const CANDIDATE_WINDOW = 60;

export const ROLE_DISPLAY_NAMES = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  BOTTOM: "ADC",
  UTILITY: "Support",
  OTHER: "Other",
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

/* ---------- Request budget ---------- */

// Riot's documented limits for a development/personal key. The proxy strips Riot's own
// rate-limit headers, so this side counts what it sends and reports it — it does not stall
// waiting for room. A caller that is about to overrun asks the human first.
export const RATE_LIMIT_PER_WINDOW = 100;
export const RATE_WINDOW_MS = 120000;

const sent = [];

export function requestBudget() {
  const now = Date.now();
  while (sent.length && now - sent[0] > RATE_WINDOW_MS) sent.shift();
  const used = sent.length;
  return {
    used,
    limit: RATE_LIMIT_PER_WINDOW,
    remaining: Math.max(0, RATE_LIMIT_PER_WINDOW - used),
    // When the oldest request ages out and room starts opening up again.
    resetInSeconds: used > 0 ? Math.max(0, Math.ceil((RATE_WINDOW_MS - (now - sent[0])) / 1000)) : 0,
  };
}

// A browser tab keeps one budget for its lifetime, but a CLI process starts blind — and two
// runs a minute apart share the same real limit. These let a caller persist the window so the
// guard is honest across processes.
export function exportRecentRequests() {
  requestBudget();
  return [...sent];
}

export function importRecentRequests(timestamps) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  (timestamps || []).filter((t) => t > cutoff).forEach((t) => sent.push(t));
  sent.sort((a, b) => a - b);
}

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
    this.rateLimited = true;
  }
}

// No retry loop and no waiting: a 429 stops the caller immediately so partial work can be
// saved and reported, rather than hammering a key that is already over its limit.
export async function riotFetch(path) {
  sent.push(Date.now());
  const res = await fetch(`${RIOT_PROXY_BASE}${path}`);
  const data = await res.json().catch(() => ({}));

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    throw new RateLimitError(
      `Riot rate limit hit${retryAfter ? ` — it clears in about ${retryAfter}s` : ""}. Stopped rather than pushing further.`
    );
  }
  return { ok: res.ok, status: res.status, data };
}

// What a scout will cost in Riot requests, so the caller can warn before spending it.
// Two calls per player fixed (account + ranked), then one per game examined: at best the
// target itself, at worst the whole candidate window. Cached games cost nothing, so the
// floor drops on a re-scout — but the estimate stays honest and does not assume cache hits.
export function estimateLobbyCost(playerCount, { target = RANKED_SAMPLE_TARGET, window = CANDIDATE_WINDOW } = {}) {
  const fixed = playerCount * 2;
  return {
    players: playerCount,
    best: fixed + playerCount * target,
    worst: fixed + playerCount * window,
  };
}

/* ---------- Match summary cache ---------- */

let cacheStore = null;
let cache = new Map();
let cacheLoaded = false;
let saveTimer = null;

// The caller supplies where summaries live (localStorage in the browser, a file in Node) so
// this module stays free of both. Raw matches are far too big to keep — the summary is ~200
// bytes and is all the scout ever reads.
export function configureMatchCache(store) {
  cacheStore = store;
  cache = new Map();
  cacheLoaded = false;
}

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  if (!cacheStore) return;
  try {
    const raw = cacheStore.load() || {};
    cache = new Map(Object.entries(raw));
  } catch (err) {
    console.warn("Could not read the match cache; starting empty.", err);
  }
}

function saveCacheSoon() {
  if (!cacheStore) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      // Newest entries win if the store has a size limit to enforce.
      cacheStore.save(Object.fromEntries(cache));
    } catch (err) {
      console.warn("Could not write the match cache.", err);
    }
  }, 500);
}

export function matchCacheSize() {
  loadCache();
  return cache.size;
}

/* ---------- Match shaping ---------- */

// One match as the numbers a draft actually turns on. op.gg shows these per game; the match
// record carries them, so the scout keeps them rather than stopping at win/loss and KDA.
// Damage share matters more than raw damage: it says whether they are the carry or the escort.
// Bans, runes and summoner spells all arrive as bare numeric ids. Data Dragon turns them into
// names, and it is a static CDN — no Riot key, no rate limit, so this is free to call.
let staticIndex = null;

export async function loadStaticIndex() {
  if (staticIndex) return staticIndex;
  const base = "https://ddragon.leagueoflegends.com";
  const versions = await (await fetch(`${base}/api/versions.json`)).json();
  const v = versions[0];

  const [champs, runes, spells] = await Promise.all([
    (await fetch(`${base}/cdn/${v}/data/en_US/champion.json`)).json(),
    (await fetch(`${base}/cdn/${v}/data/en_US/runesReforged.json`)).json(),
    (await fetch(`${base}/cdn/${v}/data/en_US/summoner.json`)).json(),
  ]);

  const index = { champions: {}, runes: {}, spells: {} };
  Object.values(champs.data).forEach((c) => {
    index.champions[c.key] = c.name;
  });
  // Keystones are the first row of each tree; the tree itself is also named, for secondaries.
  runes.forEach((tree) => {
    index.runes[tree.id] = tree.name;
    tree.slots.forEach((slot) => slot.runes.forEach((r) => (index.runes[r.id] = r.name)));
  });
  Object.values(spells.data).forEach((s) => {
    index.spells[s.key] = s.name;
  });

  staticIndex = index;
  return staticIndex;
}

export function championName(key) {
  return staticIndex?.champions?.[String(key)] || `#${key}`;
}

export function runeName(id) {
  return staticIndex?.runes?.[String(id)] || `rune ${id}`;
}

export function spellName(id) {
  return staticIndex?.spells?.[String(id)] || `spell ${id}`;
}

// "4/12" is unreadable; "Flash + Teleport" is the thing you plan against.
export function spellPairName(pair) {
  return String(pair)
    .split("/")
    .map((id) => spellName(id))
    .join(" + ");
}

export function summarizeMatch(match, puuid) {
  const me = match?.info?.participants?.find((p) => p.puuid === puuid);
  if (!me) return null;

  // A remake is not a loss. It shows up as a ~1 minute game with an empty scoreline, and
  // counting it drags a win rate down for something nobody played.
  const remake = Boolean(me.gameEndedInEarlySurrender) || (match.info.gameDuration || 0) < 300;

  const minutes = Math.max(1, (match.info.gameDuration || 0) / 60);
  const damage = me.totalDamageDealtToChampions || 0;
  const teamDamage = match.info.participants
    .filter((p) => p.teamId === me.teamId)
    .reduce((sum, p) => sum + (p.totalDamageDealtToChampions || 0), 0);
  const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);

  // Everything below is already inside the match record we paid for. Keeping it costs a few
  // hundred bytes of cache and no extra requests, which is why the scout takes it all.
  const ch = me.challenges || {};
  const myTeam = match.info.teams?.find((t) => t.teamId === me.teamId);
  const enemyTeam = match.info.teams?.find((t) => t.teamId !== me.teamId);
  const banIds = (team) => (team?.bans || []).map((b) => b.championId).filter((id) => id > 0);
  const num = (v, digits) => (typeof v === "number" ? Number(v.toFixed(digits)) : null);

  return {
    champion: me.championName,
    // Kept alongside the name because ban lists are numeric ids and have to join against it.
    championId: me.championId ?? null,
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
    remake,
    queueId: match.info.queueId ?? null,
    queue: RANKED_QUEUES[match.info.queueId] || null,
    playedAt: match.info.gameEndTimestamp || match.info.gameStartTimestamp || null,

    side: me.teamId === 100 ? "blue" : "red",
    spells: [me.summoner1Id, me.summoner2Id].filter(Boolean),
    keystone: me.perks?.styles?.[0]?.selections?.[0]?.perk ?? null,
    secondaryTree: me.perks?.styles?.[1]?.style ?? null,

    // Bans are a lobby-wide fact, not this player's choice — see contestRate below for the
    // reading that survives that. Stored per side so "what their team removed" stays separable.
    bans: { ally: banIds(myTeam), enemy: banIds(enemyTeam) },

    // The laning-phase picture. Nulls are kept as nulls: Riot omits challenges on some games,
    // and a missing value must not be averaged in as a zero.
    lane: {
      cs10: ch.laneMinionsFirst10Minutes ?? null,
      jungleCs10: ch.jungleCsBefore10Minutes ?? null,
      plates: ch.turretPlatesTaken ?? null,
      soloKills: ch.soloKills ?? null,
      earlyAdvantage: num(ch.earlyLaningPhaseGoldExpAdvantage, 0),
      killParticipation: typeof ch.killParticipation === "number" ? Math.round(ch.killParticipation * 100) : null,
      visionPerMin: num(ch.visionScorePerMinute, 2),
      goldPerMin: num(ch.goldPerMinute, 0),
    },

    objectives: {
      firstBlood: Boolean(myTeam?.objectives?.champion?.first),
      firstDragon: Boolean(myTeam?.objectives?.dragon?.first),
      firstTower: Boolean(myTeam?.objectives?.tower?.first),
      dragons: myTeam?.objectives?.dragon?.kills ?? 0,
      barons: myTeam?.objectives?.baron?.kills ?? 0,
      towers: myTeam?.objectives?.tower?.kills ?? 0,
    },
  };
}

// Bumped whenever the summary shape gains fields, so old rows are refetched rather than
// silently reported as missing data. One prefix invalidates the browser and the CLI together.
const SUMMARY_VERSION = "v2";

async function getMatchSummary(matchId, puuid) {
  loadCache();
  const key = `${SUMMARY_VERSION}:${matchId}:${puuid}`;
  if (cache.has(key)) return cache.get(key);

  const { ok, data } = await riotFetch(`/match/${matchId}`);
  if (!ok) return null;

  const summary = summarizeMatch(data, puuid);
  // A null summary is cached too: it means this puuid was not in the match, and asking again
  // will not change that.
  cache.set(key, summary);
  saveCacheSoon();
  return summary;
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
//   https://op.gg/fr/lol/multisearch/na?summoners=...   (locale segment, + for spaces)
//   https://na.op.gg/multi/query=name1%2Cname2          (legacy — no tags in it)
//   Name#TAG, Other#TAG                                 (raw paste)
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

function summarizeRankedEntry(entry) {
  return {
    tier: `${titleCase(entry.tier)} ${entry.rank}`,
    lp: entry.leaguePoints,
    wins: entry.wins,
    losses: entry.losses,
    winRate: entry.wins + entry.losses > 0 ? Math.round((entry.wins / (entry.wins + entry.losses)) * 100) : 0,
  };
}

function averageBy(rows, key) {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((sum, r) => sum + (r[key] || 0), 0) / rows.length);
}

function winRate(wins, games) {
  return games > 0 ? Math.round((wins / games) * 100) : 0;
}

function mean(rows, pick, digits = 1) {
  const values = rows.map(pick).filter((v) => typeof v === "number");
  if (values.length === 0) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(digits));
}

// The laning-phase picture, averaged. This is what turns "Diamond III" into "farms, never
// gets an early lead, shows up for half the kills" — which is a draft decision, not trivia.
function laneProfile(rows) {
  if (rows.length === 0) return null;
  return {
    cs10: mean(rows, (r) => r.lane?.cs10),
    jungleCs10: mean(rows, (r) => r.lane?.jungleCs10),
    plates: mean(rows, (r) => r.lane?.plates),
    soloKills: mean(rows, (r) => r.lane?.soloKills, 2),
    earlyAdvantage: mean(rows, (r) => r.lane?.earlyAdvantage, 0),
    killParticipation: mean(rows, (r) => r.lane?.killParticipation, 0),
    visionPerMin: mean(rows, (r) => r.lane?.visionPerMin, 2),
    goldPerMin: mean(rows, (r) => r.lane?.goldPerMin, 0),
  };
}

function sideRecord(rows) {
  const count = (side) => {
    const games = rows.filter((r) => r.side === side);
    const wins = games.filter((r) => r.win).length;
    return { games: games.length, wins, winRate: winRate(wins, games.length) };
  };
  return { blue: count("blue"), red: count("red") };
}

function objectiveProfile(rows) {
  if (rows.length === 0) return null;
  const rate = (pick) => Math.round((rows.filter(pick).length / rows.length) * 100);
  return {
    firstBlood: rate((r) => r.objectives?.firstBlood),
    firstDragon: rate((r) => r.objectives?.firstDragon),
    firstTower: rate((r) => r.objectives?.firstTower),
    dragonsPerGame: mean(rows, (r) => r.objectives?.dragons),
  };
}

// In solo and flex queue the ten bans are ten different people's choices, so "their team's ban
// tendencies" is mostly noise. What does survive is how often a champion is removed from the
// lobby at all: if someone's best champion is gone in half their games, that is a contested
// pick they rarely get, and a cheap one for you to take away. Custom games are the case where
// bans really are a team's decision — those are logged separately.
function contestProfile(rows, champions) {
  if (rows.length === 0) return { pool: [], lobbyMostBanned: [] };

  const banCount = new Map();
  rows.forEach((r) => {
    [...(r.bans?.ally || []), ...(r.bans?.enemy || [])].forEach((id) => {
      banCount.set(id, (banCount.get(id) || 0) + 1);
    });
  });

  const pool = champions.map((c) => {
    const banned = banCount.get(c.championId) || 0;
    return { name: c.name, championId: c.championId, bannedIn: banned, contestRate: winRate(banned, rows.length) };
  });

  const lobbyMostBanned = [...banCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([championId, games]) => ({ championId, games, rate: winRate(games, rows.length) }));

  return { pool, lobbyMostBanned };
}

// What they bring on a champion, when it is consistent enough to plan against.
function tendencies(rows) {
  const commonest = (values) => {
    const counts = new Map();
    values.filter((v) => v != null).forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
    if (counts.size === 0) return null;
    const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return { value, count, of: values.length };
  };
  return {
    keystone: commonest(rows.map((r) => r.keystone)),
    spells: commonest(rows.map((r) => (r.spells || []).slice().sort((a, b) => a - b).join("/"))),
  };
}

// Per-champion winrate over the sample, split by queue. The split is the point: a champion
// someone is 70% on in flex and 40% on in solo is a champion they play with a premade around
// them, which is exactly the situation a custom game reproduces.
function championBreakdown(rows) {
  const byChampion = new Map();

  rows.forEach((row) => {
    if (!byChampion.has(row.champion)) {
      byChampion.set(row.champion, { name: row.champion, rows: [], solo: { games: 0, wins: 0 }, flex: { games: 0, wins: 0 } });
    }
    const champ = byChampion.get(row.champion);
    champ.rows.push(row);
    const bucket = row.queue === "flex" ? champ.flex : champ.solo;
    bucket.games++;
    if (row.win) bucket.wins++;
  });

  return [...byChampion.values()]
    .map((champ) => {
      const kills = champ.rows.reduce((s, r) => s + r.kills, 0);
      const deaths = champ.rows.reduce((s, r) => s + r.deaths, 0);
      const assists = champ.rows.reduce((s, r) => s + r.assists, 0);
      const wins = champ.solo.wins + champ.flex.wins;
      const games = champ.rows.length;

      return {
        name: champ.name,
        championId: champ.rows[0]?.championId ?? null,
        games,
        wins,
        winRate: winRate(wins, games),
        solo: { ...champ.solo, winRate: winRate(champ.solo.wins, champ.solo.games) },
        flex: { ...champ.flex, winRate: winRate(champ.flex.wins, champ.flex.games) },
        kda: deaths > 0 ? (kills + assists) / deaths : kills + assists,
        dpm: averageBy(champ.rows, "dpm"),
        damageShare: averageBy(champ.rows, "damageShare"),
        csPerMin: Number((champ.rows.reduce((s, r) => s + r.csPerMin, 0) / games).toFixed(1)),
        roles: [...new Set(champ.rows.map((r) => r.role))],
        tendencies: tendencies(champ.rows),
      };
    })
    .sort((a, b) => b.games - a.games || b.winRate - a.winRate);
}

// Walks their recent games newest-first and keeps the ranked ones until it has enough. The
// walk stops early the moment the target is met, so a player who only plays ranked costs
// barely more than the target itself.
async function collectRankedSample(puuid, { target, window, onProgress }) {
  const { ok, data: ids } = await riotFetch(`/matches?puuid=${puuid}&count=${window}`);
  if (!ok) throw new Error(riotErrorMessage(ids, "Could not load match history"));

  const rows = [];
  let scanned = 0;

  for (const id of Array.isArray(ids) ? ids : []) {
    if (rows.length >= target) break;
    scanned++;
    const summary = await getMatchSummary(id, puuid);
    if (summary && summary.queue && !summary.remake) rows.push(summary);
    if (onProgress && scanned % 10 === 0) onProgress({ scanned, found: rows.length });
  }

  return { rows, scanned, candidates: Array.isArray(ids) ? ids.length : 0 };
}

// roster is the shared player list ([{ name, riotId }]) so a scouted account that belongs to
// one of ours is labelled as such instead of reading as a stranger.
export async function scoutOnePlayer(player, roster = [], options = {}) {
  const { target = RANKED_SAMPLE_TARGET, window = CANDIDATE_WINDOW, onProgress } = options;
  const riotId = player.tagLine ? `${player.gameName}#${player.tagLine}` : player.gameName;
  const matched = roster.find((p) => (p.riotId || "").toLowerCase() === riotId.toLowerCase());
  const base = { riotId, matchedPersonName: matched ? matched.name : null };

  if (!player.tagLine) {
    return { ...base, error: "No #tag in the link — Riot needs Name#TAG to look this player up." };
  }

  try {
    const account = await riotFetch(
      `/account?gameName=${encodeURIComponent(player.gameName)}&tagLine=${encodeURIComponent(player.tagLine)}`
    );
    if (!account.ok) throw new Error(riotErrorMessage(account.data, "Could not find that Riot ID"));
    const puuid = account.data.puuid;

    const ranked = await riotFetch(`/ranked?puuid=${puuid}`);
    if (!ranked.ok) throw new Error(riotErrorMessage(ranked.data, "Could not load ranked stats"));

    const { rows, scanned, candidates } = await collectRankedSample(puuid, { target, window, onProgress });

    const rankedList = Array.isArray(ranked.data) ? ranked.data : [];
    const solo = rankedList.find((r) => r.queueType === "RANKED_SOLO_5x5");
    const flex = rankedList.find((r) => r.queueType === "RANKED_FLEX_SR");

    const soloRows = rows.filter((r) => r.queue === "solo");
    const flexRows = rows.filter((r) => r.queue === "flex");
    const wins = rows.filter((r) => r.win).length;
    const kills = rows.reduce((s, r) => s + r.kills, 0);
    const deaths = rows.reduce((s, r) => s + r.deaths, 0);
    const assists = rows.reduce((s, r) => s + r.assists, 0);

    const roleCounts = {};
    rows.forEach((r) => {
      roleCounts[r.role] = (roleCounts[r.role] || 0) + 1;
    });

    const championList = championBreakdown(rows);

    return {
      ...base,
      solo: solo ? summarizeRankedEntry(solo) : null,
      flex: flex ? summarizeRankedEntry(flex) : null,
      recent: {
        games: rows.length,
        wins,
        losses: rows.length - wins,
        winRate: winRate(wins, rows.length),
        soloGames: soloRows.length,
        soloWinRate: winRate(soloRows.filter((r) => r.win).length, soloRows.length),
        flexGames: flexRows.length,
        flexWinRate: winRate(flexRows.filter((r) => r.win).length, flexRows.length),
        // How hard we had to dig says something on its own: 30 ranked games inside the last
        // 30 played is a ranked regular, 30 inside 60 is someone splitting with ARAM.
        scanned,
        candidates,
        kda: deaths > 0 ? (kills + assists) / deaths : kills + assists,
        roles: Object.entries(roleCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([role, games]) => ({ role, games })),
        champions: championList,
        matches: rows,
        lane: laneProfile(rows),
        sides: sideRecord(rows),
        objectives: objectiveProfile(rows),
        contest: contestProfile(rows, championList),
      },
    };
  } catch (err) {
    // Hitting the rate limit is not this player's problem — it stops the whole scout, so it
    // travels up rather than being recorded as "this account could not be read".
    if (err.rateLimited) throw err;

    // One unreachable player must not sink the scout, and the reason travels on the record
    // itself — a bare stack trace per player buries the report that follows.
    const message = err.message || "Lookup failed.";
    console.warn(`Scouting ${riotId} failed: ${message}`);
    return { ...base, error: message };
  }
}

export async function scoutLobby(opggUrl, roster = [], options = {}) {
  const { onProgress, onPlayer, target = RANKED_SAMPLE_TARGET, window = CANDIDATE_WINDOW } = options;
  const parsed = parseOpggMultiSearch(opggUrl);
  if (parsed.players.length === 0) throw new Error("No players found in that op.gg link.");

  const players = [];
  // Sequential on purpose: a whole lobby looked up in parallel trips Riot's rate limit, and a
  // scout that half-fails is worse than one that takes a few extra seconds.
  for (const [index, player] of parsed.players.entries()) {
    const label = player.tagLine ? `${player.gameName}#${player.tagLine}` : player.gameName;
    if (onProgress) onProgress({ index, total: parsed.players.length, riotId: label, stage: "start" });

    let scouted;
    try {
      scouted = await scoutOnePlayer(player, roster, {
        target,
        window,
        onProgress: (p) => onProgress?.({ index, total: parsed.players.length, riotId: label, stage: "scanning", ...p }),
      });
    } catch (err) {
      // Carry the players already finished on the error, so the caller can keep them.
      err.players = players;
      throw err;
    }

    players.push(scouted);
    if (onProgress) onProgress({ index, total: parsed.players.length, riotId: label, stage: "done" });
    // Handing back each player as they land lets a caller save progressively, so a rate limit
    // hit near the end does not throw away four completed players.
    if (onPlayer) await onPlayer(scouted, players);
  }

  return {
    region: parsed.region,
    sampleTarget: target,
    candidateWindow: window,
    queues: "ranked solo + flex",
    fetchedAt: new Date().toISOString(),
    players,
  };
}

/* ---------- Text formatting (shared by the tab's copy button and the CLI) ---------- */

export function formatScoutedPlayer(p) {
  const who = p.matchedPersonName ? `${p.riotId} [roster: ${p.matchedPersonName}]` : p.riotId;
  if (p.error) return `${who} — lookup failed: ${p.error}`;

  const rank = p.solo ? `${p.solo.tier} ${p.solo.lp}LP ${p.solo.wins}W/${p.solo.losses}L` : "Unranked solo";
  const flex = p.flex ? `, Flex ${p.flex.tier}` : "";
  const r = p.recent || {};
  const sample =
    r.games > 0
      ? `last ${r.games} ranked ${r.winRate}%WR (solo ${r.soloGames}g ${r.soloWinRate}%, flex ${r.flexGames}g ${r.flexWinRate}%)`
      : "no ranked games in the window";
  const roles = (r.roles || []).map((x) => `${x.role}×${x.games}`).join("/") || "no roles";
  const champs =
    (r.champions || [])
      .slice(0, 6)
      .map((c) => `${c.name} ${c.wins}/${c.games} ${c.winRate}%WR ${c.kda.toFixed(1)}kda ${c.dpm}dpm ${c.damageShare}%dmg`)
      .join(", ") || "none";
  return `${who} — ${rank}${flex} · ${sample} · ${roles} · ${champs}`;
}

// The reads that come free with the match record: laning shape, side bias, objective habits,
// and which of their champions the lobby keeps removing.
export function formatScoutedPlayerProfile(p) {
  const r = p.recent;
  if (!r || !r.games) return [];
  const lines = [];

  const l = r.lane || {};
  const lane = [
    l.cs10 != null ? `${l.cs10} cs@10` : null,
    l.jungleCs10 ? `${l.jungleCs10} jgcs@10` : null,
    l.plates != null ? `${l.plates} plates` : null,
    l.soloKills != null ? `${l.soloKills} solo kills` : null,
    l.earlyAdvantage != null ? `${l.earlyAdvantage > 0 ? "+" : ""}${l.earlyAdvantage} early g/xp` : null,
    l.killParticipation != null ? `${l.killParticipation}% KP` : null,
    l.visionPerMin != null ? `${l.visionPerMin} vis/min` : null,
    l.goldPerMin != null ? `${l.goldPerMin} gpm` : null,
  ].filter(Boolean);
  if (lane.length) lines.push(`lane: ${lane.join(" · ")}`);

  const s = r.sides;
  if (s) {
    lines.push(
      `side: blue ${s.blue.wins}/${s.blue.games} (${s.blue.winRate}%) · red ${s.red.wins}/${s.red.games} (${s.red.winRate}%)`
    );
  }

  const o = r.objectives;
  if (o) {
    lines.push(
      `objectives: first blood ${o.firstBlood}% · first drake ${o.firstDragon}% · ` +
        `first tower ${o.firstTower}% · ${o.dragonsPerGame} drakes/game`
    );
  }

  const contested = (r.contest?.pool || [])
    .filter((c) => c.contestRate >= 20)
    .sort((a, b) => b.contestRate - a.contestRate);
  if (contested.length) {
    lines.push(`contested: ${contested.map((c) => `${c.name} banned in ${c.contestRate}% of their games`).join(", ")}`);
  }

  const banMeta = (r.contest?.lobbyMostBanned || []).slice(0, 5);
  if (banMeta.length) {
    lines.push(`their lobbies ban: ${banMeta.map((b) => `${championName(b.championId)} ${b.rate}%`).join(", ")}`);
  }

  const tend = (r.champions || [])
    .slice(0, 3)
    .map((c) => {
      const t = c.tendencies || {};
      const bits = [];
      if (t.keystone && t.keystone.count > 1) bits.push(`${runeName(t.keystone.value)} ${t.keystone.count}/${t.keystone.of}`);
      if (t.spells && t.spells.count > 1) bits.push(`${spellPairName(t.spells.value)} ${t.spells.count}/${t.spells.of}`);
      return bits.length ? `${c.name} — ${bits.join(", ")}` : null;
    })
    .filter(Boolean);
  if (tend.length) lines.push(`tendencies: ${tend.join(" | ")}`);

  return lines;
}

// The game-by-game lines, for when the averages hide the story (a losing streak, one
// off-role game, a smurf's first week). Used by the CLI's `get`, not by the tab's cards.
export function formatScoutedPlayerMatches(p) {
  return (p.recent?.matches || []).map(
    (m) =>
      `${m.win ? "W" : "L"} ${m.champion} (${m.role}, ${m.queue}) ${m.kills}/${m.deaths}/${m.assists} · ` +
      `${m.dpm}dpm ${m.damageShare}%dmg ${m.csPerMin}cs/m vis${m.visionScore} · ${m.durationMin}min`
  );
}
