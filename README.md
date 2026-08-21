# LWG Team Tool

The tool my League of Legends team actually runs on: champion pools, the
tier ratings our coach drafts from, opponent scouting, and a strategy Q&A
board — all live-synced, so the whole team is looking at the same state
during a draft.

**In real use by a competitive team and its coach.** Deployed on GitHub
Pages; pushing to `main` deploys.

## What's in it

- **Web app** (`index.html` / `app.js` / `style.css`) — vanilla JS, no
  build step. Firebase Firestore with `onSnapshot` live sync, so edits
  appear on everyone's screen as they happen. Per-collection Firestore
  security rules.
- **`riot.mjs`** — Riot API scouting: paste an op.gg multi-search link
  and it profiles every player in the lobby. Carries its own request
  budgeting and a match cache, because Riot's rate limits are real and
  scouting a full lobby is expensive without one.
- **`strategy.mjs`** — CLI half of the Strategy tab. The tab collects
  questions ("what do we ban against this lobby?"); this script reads
  them and writes answers back into the same Firestore the app watches,
  so an answer typed in a terminal lands on the board everyone sees.
- **`custom-game-logger.ps1`** — logs our custom games for post-game
  stats.

## Why it's built this way

No framework and no build step is deliberate: the whole app is readable
in an afternoon, deploys as static files, and the database does the
realtime work. The Riot integration treats the API budget as a first-class
constraint rather than a surprise.
