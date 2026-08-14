#!/usr/bin/env node
/*
LWG Team Tool — Strategy CLI
----------------------------
The Strategy tab collects questions ("what should we ban against this lobby?") and,
when an op.gg multi-search link is attached, a scout of every player in it. This script
is the other half: it reads those questions and writes the answers back, so an answer
typed by Claude in a chat window lands in the tab everyone is looking at.

It talks only to firestore.googleapis.com — the same database the web app uses, with the
same open access. No API key, no build step, no dependencies (Node 18+ for global fetch).

  node strategy.mjs list                     # questions waiting for an answer
  node strategy.mjs list --all               # answered ones too
  node strategy.mjs get <id>                 # one question in full, game by game
  node strategy.mjs answer <id> <file.md>    # write an answer ("-" reads stdin)
  node strategy.mjs scout <opgg-url>         # scout a lobby right here ("--id X" saves it onto X)
  node strategy.mjs ask "question" [--category Bans] [--opgg URL] [--answer file.md]

Handed an op.gg multi-search link in a chat window, `scout` is the whole job: it reads the
players out of the link, pulls their ranks and recent games from Riot, and prints them.

Answers are Markdown-lite: ## headings, - bullets, 1. numbered, **bold**, `code`, and
[[Champion Name]] which the tab renders as a champion icon chip. Anything fancier than
that is shown as plain text, so keep to those.
*/

import { readFileSync } from "node:fs";
import {
  RANKED_SAMPLE_TARGET,
  RATE_LIMIT_PER_WINDOW,
  configureMatchCache,
  estimateLobbyCost,
  exportRecentRequests,
  formatScoutedPlayer,
  importRecentRequests,
  formatScoutedPlayerMatches,
  parseOpggMultiSearch,
  requestBudget,
  scoutLobby,
} from "./riot.mjs";
import { existsSync, readFileSync as readCache, writeFileSync } from "node:fs";

// Same idea as the browser's localStorage cache: match summaries are immutable, so a re-scout
// only pays for games played since. Kept beside the script and out of git.
const CACHE_FILE = new URL("./.match-cache.json", import.meta.url);
configureMatchCache({
  load: () => (existsSync(CACHE_FILE) ? JSON.parse(readCache(CACHE_FILE, "utf8")) : {}),
  save: (entries) => writeFileSync(CACHE_FILE, JSON.stringify(entries), "utf8"),
});

// Riot's limit does not reset because a process did. Two `scout` runs a minute apart share one
// budget, so the window is carried between them on disk.
const BUDGET_FILE = new URL("./.riot-budget.json", import.meta.url);
if (existsSync(BUDGET_FILE)) {
  try {
    importRecentRequests(JSON.parse(readCache(BUDGET_FILE, "utf8")));
  } catch {
    // A corrupt budget file only costs us the guard's memory of the last two minutes.
  }
}
process.on("exit", () => {
  try {
    writeFileSync(BUDGET_FILE, JSON.stringify(exportRecentRequests()), "utf8");
  } catch {
    // Nothing useful to do at exit.
  }
});

const BASE = "https://firestore.googleapis.com/v1/projects/champ-pool-lwg/databases/(default)/documents";
// Strategy entries share the "notes" collection under type "strategy" — the Firestore rules
// name each collection explicitly, so a "strategies" collection is denied until someone edits
// them in the console. Everything below filters on that type; see strategyDoc() in app.js.
const COLLECTION = "notes";
const TYPE = "strategy";

/* ---------- Firestore value encoding ---------- */

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

function toFields(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toValue(v)]));
}

function fromValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  return null;
}

function fromFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromValue(v)]));
}

async function firestore(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message || `Firestore returned ${res.status}`);
  }
  return body;
}

async function listStrategies() {
  const body = await firestore(`/${COLLECTION}?pageSize=300`);
  return (body.documents || [])
    .map((d) => ({ id: d.name.split("/").pop(), ...fromFields(d.fields || {}) }))
    .filter((e) => e.type === TYPE)
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

/* ---------- Formatting ---------- */

async function loadRoster() {
  const body = await firestore("/people?pageSize=100");
  return (body.documents || []).map((d) => fromFields(d.fields || {}));
}

function formatEntry(entry, { verbose } = {}) {
  const lines = [];
  const asked = entry.createdAt ? entry.createdAt.toISOString().replace("T", " ").slice(0, 16) : "unknown time";
  lines.push(`[${entry.status || "pending"}] ${entry.id}`);
  lines.push(`  ${entry.category || "General"} · asked ${asked}${entry.askedBy ? ` by ${entry.askedBy}` : ""}`);
  lines.push(`  Q: ${entry.question}`);
  if (entry.opggUrl) lines.push(`  op.gg: ${entry.opggUrl}`);
  if (entry.scoutError) lines.push(`  scout failed: ${entry.scoutError}`);

  const scout = parseScout(entry);
  if (scout) {
    lines.push(`  Lobby scout (last ${scout.matchesPerPlayer} games each, fetched ${scout.fetchedAt}):`);
    scout.players.forEach((p) => {
      lines.push(`    ${formatScoutedPlayer(p)}`);
      if (verbose) formatScoutedPlayerMatches(p).forEach((m) => lines.push(`        ${m}`));
    });
  } else if (entry.opggUrl) {
    lines.push("  (no scout stored — run a scout from the tab, or answer without one)");
  }

  if (verbose && entry.answer) {
    lines.push("  A:");
    entry.answer.split("\n").forEach((l) => lines.push(`    ${l}`));
  }
  return lines.join("\n");
}

function parseScout(entry) {
  if (!entry.scoutJson) return null;
  try {
    return JSON.parse(entry.scoutJson);
  } catch {
    return null;
  }
}

/* ---------- Commands ---------- */

async function cmdList(args) {
  const all = args.includes("--all");
  const entries = await listStrategies();
  const shown = all ? entries : entries.filter((e) => e.status !== "answered");

  if (shown.length === 0) {
    console.log(all ? "No strategy questions yet." : "Nothing waiting — every question has an answer.");
    return;
  }
  shown.forEach((e) => {
    console.log(formatEntry(e));
    console.log("");
  });
}

async function cmdGet(args) {
  const id = args[0];
  if (!id) throw new Error("Usage: strategy.mjs get <id>");
  const body = await firestore(`/${COLLECTION}/${encodeURIComponent(id)}`);
  const entry = { id, ...fromFields(body.fields || {}) };
  if (entry.type !== TYPE) throw new Error(`${id} is a ${entry.type || "unknown"} note, not a strategy question.`);
  console.log(formatEntry(entry, { verbose: true }));
}

function readAnswerSource(source) {
  if (!source) throw new Error("No answer file given.");
  const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  const trimmed = text.trim();
  if (!trimmed) throw new Error("That answer is empty.");
  return trimmed;
}

async function cmdAnswer(args) {
  const [id, source] = args;
  if (!id || !source) throw new Error('Usage: strategy.mjs answer <id> <file.md>   ("-" reads stdin)');
  const answer = readAnswerSource(source);

  // The collection is shared with the Notes tab, so refuse to stamp an answer onto a note.
  const existing = await firestore(`/${COLLECTION}/${encodeURIComponent(id)}`);
  const entry = fromFields(existing.fields || {});
  if (entry.type !== TYPE) throw new Error(`${id} is a ${entry.type || "unknown"} note, not a strategy question.`);

  const fields = toFields({ answer, answeredAt: new Date(), status: "answered" });
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${f}`)
    .join("&");

  await firestore(`/${COLLECTION}/${encodeURIComponent(id)}?${mask}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  console.log(`Answered ${id} — it is live in the Strategy tab now.`);
}

// The CLI's version of the tab's popup: it cannot open a dialog, so it refuses and explains,
// and --yes is the deliberate act of saying "spend it anyway".
function guardRiotSpend(playerCount, target, args) {
  const cost = estimateLobbyCost(playerCount, { target });
  const budget = requestBudget();
  if (cost.worst <= budget.remaining || args.includes("--yes")) return;

  throw new Error(
    `This would poll ${playerCount} players × ${target} ranked games — about ${cost.best}-${cost.worst} Riot ` +
      `requests, against a limit of ${RATE_LIMIT_PER_WINDOW} every 2 minutes (${budget.remaining} left right now).\n` +
      `It will be cut off partway. Polled games are cached, so a retry resumes cheaply.\n` +
      `Re-run with --yes to do it anyway, or --games 10 for a smaller sample.`
  );
}

async function cmdScout(args) {
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) throw new Error("Usage: strategy.mjs scout <opgg-multisearch-url> [--games N] [--yes] [--id <strategyId>]");

  const gamesIndex = args.indexOf("--games");
  const target = gamesIndex === -1 ? RANKED_SAMPLE_TARGET : Number(args[gamesIndex + 1]) || RANKED_SAMPLE_TARGET;
  const { players } = parseOpggMultiSearch(url);
  guardRiotSpend(players.length, target, args);

  const scout = await scoutLobby(url, await loadRoster(), {
    target,
    onProgress: ({ index, total, riotId, stage, found }) => {
      if (stage === "start") process.stderr.write(`  [${index + 1}/${total}] ${riotId}…\n`);
      else if (stage === "scanning") process.stderr.write(`      ${found} ranked games so far\r`);
    },
  });
  console.log(`Lobby poll — up to ${scout.sampleTarget} ranked games each (solo + flex)${scout.region ? `, ${scout.region}` : ""}:`);
  scout.players.forEach((p) => {
    console.log(`  ${formatScoutedPlayer(p)}`);
    formatScoutedPlayerMatches(p).forEach((m) => console.log(`      ${m}`));
  });

  const idIndex = args.indexOf("--id");
  if (idIndex !== -1 && args[idIndex + 1]) {
    const id = args[idIndex + 1];
    const fields = toFields({ scoutJson: JSON.stringify(scout), scoutError: null, opggUrl: url });
    const mask = Object.keys(fields)
      .map((f) => `updateMask.fieldPaths=${f}`)
      .join("&");
    await firestore(`/${COLLECTION}/${encodeURIComponent(id)}?${mask}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    console.log(`\nSaved onto ${id} — the card in the tab shows it now.`);
  }
}

async function cmdAsk(args) {
  const question = args.find((a) => !a.startsWith("--"));
  if (!question) throw new Error('Usage: strategy.mjs ask "question" [--category X] [--opgg URL] [--answer file.md]');

  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1] || null;
  };

  const answerFile = flag("answer");
  const answer = answerFile ? readAnswerSource(answerFile) : null;
  const id = crypto.randomUUID();

  await firestore(`/${COLLECTION}?documentId=${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: toFields({
        type: TYPE,
        question,
        category: flag("category") || "General",
        opggUrl: flag("opgg"),
        askedBy: flag("by") || "Claude",
        status: answer ? "answered" : "pending",
        answer,
        answeredAt: answer ? new Date() : null,
        createdAt: new Date(),
        scoutJson: null,
        scoutError: null,
      }),
    }),
  });
  console.log(`Posted ${id}${answer ? " with its answer" : " — waiting for an answer"}.`);
}

const [command, ...args] = process.argv.slice(2);
const commands = { list: cmdList, get: cmdGet, answer: cmdAnswer, scout: cmdScout, ask: cmdAsk };

if (!commands[command]) {
  console.log(
    [
      "Usage:",
      "  node strategy.mjs list [--all]",
      "  node strategy.mjs get <id>",
      "  node strategy.mjs answer <id> <file.md>",
      "  node strategy.mjs scout <opgg-url> [--games N] [--yes] [--id <strategyId>]",
      '  node strategy.mjs ask "question" [--category X] [--opgg URL] [--by name] [--answer file.md]',
    ].join("\n")
  );
  process.exit(command ? 1 : 0);
}

commands[command](args).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
