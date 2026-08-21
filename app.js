import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc as fsSetDoc,
  updateDoc as fsUpdateDoc,
  deleteDoc as fsDeleteDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  RANKED_SAMPLE_TARGET,
  RATE_LIMIT_PER_WINDOW,
  ROLE_DISPLAY_NAMES,
  aggregateStats,
  configureMatchCache,
  estimateLobbyCost,
  formatScoutedPlayer,
  formatScoutedPlayerProfile,
  loadStaticIndex,
  parseOpggMultiSearch,
  requestBudget,
  riotErrorMessage,
  riotFetch,
  scoutLobby,
  splitRiotId,
  titleCase,
} from "./riot.mjs";

const firebaseConfig = {
  apiKey: "AIzaSyDXoWE7c9CgXqDfCaHBfQJhoKkcU5AUv88",
  authDomain: "champ-pool-lwg.firebaseapp.com",
  projectId: "champ-pool-lwg",
  storageBucket: "champ-pool-lwg.firebasestorage.app",
  messagingSenderId: "201269608329",
  appId: "1:201269608329:web:98929bafcc725619dd2b58",
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);
let currentUser = null;

// The one account that manages who else can edit (the Team tab). Must match
// isAdmin() in firestore.rules — the rules are the enforcement; this constant
// only decides what the page shows.
const ADMIN_EMAIL = "duskliberty@gmail.com";

// Writes go through these wrappers so a permission-denied from the Firestore
// rules turns into one plain explanation instead of a silent console error.
// The rules are the actual gate; onSnapshot reverts any optimistic local echo
// of a refused write, so swallowing the denial cannot leave phantom state.
function explainDenied(err) {
  if (err && err.code === "permission-denied") {
    alert(currentUser
      ? `${currentUser.email} is signed in but not on the team list in the Firestore rules.`
      : "This tool is read-only until you sign in (top right) with a team account.");
    return;
  }
  throw err;
}
const setDoc = (...args) => fsSetDoc(...args).catch(explainDenied);
const updateDoc = (...args) => fsUpdateDoc(...args).catch(explainDenied);
const deleteDoc = (...args) => fsDeleteDoc(...args).catch(explainDenied);
const peopleCol = collection(db, "people");
const eventsCol = collection(db, "events");
const teamCompsCol = collection(db, "teamComps");
const customGamesCol = collection(db, "customGames");
const notesCol = collection(db, "notes");
const draftStateDocRef = doc(db, "draftState", "current");
const allowlistCol = collection(db, "allowlist");

function personDoc(id) {
  return doc(peopleCol, id);
}

function eventDoc(id) {
  return doc(eventsCol, id);
}

function teamCompDoc(id) {
  return doc(teamCompsCol, id);
}

function noteDoc(id) {
  return doc(notesCol, id);
}

// Strategy questions live in the "notes" collection under type "strategy" rather than a
// collection of their own. The security rules name every collection explicitly, so a new one
// is denied until someone edits them in the Firebase console — and "notes" is already the
// typed store for team-written text. Moving to a real "strategies" collection later is this
// function plus the filter in handleNotesSnapshot.
function strategyDoc(id) {
  return doc(notesCol, id);
}

const ROLES = ["Top", "Jungle", "Mid", "ADC", "Support", "Fill"];
const ROLE_SHORT = { Top: "TOP", Jungle: "JG", Mid: "MID", ADC: "ADC", Support: "SUP", Fill: "FILL" };
const COMP_ROLES = ["Top", "Jungle", "Mid", "ADC", "Support"];
const TIERS = ["S", "A", "B", "C"];
const UI_STORAGE_KEY = "championPoolManager.ui.v1";
const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";
const STATS_MATCH_COUNT = 20;
const STRATEGY_CATEGORIES = ["General", "Team Comp", "Bans", "Draft", "Matchup", "Scouting"];
// What the scout reads. "stack" narrows flex to games where every player in the link was on
// the same team — the closest ranked data gets to how a 5-stack actually plays together.
const QUEUE_SCOPES = {
  both: "Solo + Flex",
  solo: "Solo Queue only",
  flex: "Flex Queue only",
  stack: "Flex — this 5 together",
};
const SAMPLE_SIZES = [10, 20, 30];
const MATCH_CACHE_KEY = "championPoolManager.matchSummaries.v1";
// Roughly 3000 summaries is a few hundred KB — well inside localStorage's 5MB, and enough to
// hold every game a regular lobby has played for months.
const MATCH_CACHE_LIMIT = 3000;
// Standard tournament draft order: 6 bans, 6 picks, 4 more bans, 4 more picks.
const DRAFT_SEQUENCE = [
  { side: "blue", type: "ban" },
  { side: "red", type: "ban" },
  { side: "blue", type: "ban" },
  { side: "red", type: "ban" },
  { side: "blue", type: "ban" },
  { side: "red", type: "ban" },
  { side: "blue", type: "pick" },
  { side: "red", type: "pick" },
  { side: "red", type: "pick" },
  { side: "blue", type: "pick" },
  { side: "blue", type: "pick" },
  { side: "red", type: "pick" },
  { side: "red", type: "ban" },
  { side: "blue", type: "ban" },
  { side: "red", type: "ban" },
  { side: "blue", type: "ban" },
  { side: "red", type: "pick" },
  { side: "blue", type: "pick" },
  { side: "blue", type: "pick" },
  { side: "red", type: "pick" },
];
const QUEUE_NAMES = {
  400: "Normal Draft",
  420: "Ranked Solo",
  430: "Normal Blind",
  440: "Ranked Flex",
  450: "ARAM",
  700: "Clash",
  830: "Co-op vs AI",
  840: "Co-op vs AI",
  850: "Co-op vs AI",
  900: "URF",
  1700: "Arena",
};

// Lanes a champion is commonly played in — Data Dragon has no such field, so this is
// hand-curated and can lag behind brand-new champion releases until updated.
const LANES = ["Top", "Jungle", "Mid", "ADC", "Support"];
const COMMON_ROLES = {
  Aatrox: ["Top"], Ahri: ["Mid"], Akali: ["Mid", "Top"], Akshan: ["Mid", "Top"],
  Alistar: ["Support"], Ambessa: ["Top", "Mid"], Amumu: ["Jungle"], Anivia: ["Mid"],
  Annie: ["Mid", "Support"], Aphelios: ["ADC"], Ashe: ["ADC"], AurelionSol: ["Mid"],
  Aurora: ["Mid", "Top"], Azir: ["Mid"], Bard: ["Support"], Belveth: ["Jungle"],
  Blitzcrank: ["Support"], Brand: ["Support", "Mid"], Braum: ["Support"], Briar: ["Jungle"],
  Caitlyn: ["ADC"], Camille: ["Top"], Cassiopeia: ["Mid"], Chogath: ["Top"], Corki: ["Mid"],
  Darius: ["Top"], Diana: ["Jungle", "Mid"], DrMundo: ["Top"], Draven: ["ADC"],
  Ekko: ["Jungle", "Mid"], Elise: ["Jungle"], Evelynn: ["Jungle"], Ezreal: ["ADC"],
  Fiddlesticks: ["Jungle"], Fiora: ["Top"], Fizz: ["Mid"], Galio: ["Mid", "Support"],
  Gangplank: ["Top"], Garen: ["Top"], Gnar: ["Top"], Gragas: ["Jungle", "Top"],
  Graves: ["Jungle"], Gwen: ["Top", "Jungle"], Hecarim: ["Jungle"],
  Heimerdinger: ["Mid", "Support"], Hwei: ["Mid", "Support"], Illaoi: ["Top"],
  Irelia: ["Top", "Mid"], Ivern: ["Jungle"], Janna: ["Support"], JarvanIV: ["Jungle"],
  Jax: ["Top", "Jungle"], Jayce: ["Top", "Mid"], Jhin: ["ADC"], Jinx: ["ADC"],
  Kaisa: ["ADC"], Kalista: ["ADC"], Karma: ["Support", "Mid"], Karthus: ["Jungle", "Mid"],
  Kassadin: ["Mid"], Katarina: ["Mid"], Kayle: ["Top", "Mid"], Kayn: ["Jungle"],
  Kennen: ["Top"], Khazix: ["Jungle"], Kindred: ["Jungle"], Kled: ["Top"], KogMaw: ["ADC"],
  KSante: ["Top"], Leblanc: ["Mid"], LeeSin: ["Jungle"], Leona: ["Support"],
  Lillia: ["Jungle"], Lissandra: ["Mid"], Locke: ["Mid"], Lucian: ["ADC", "Mid"],
  Lulu: ["Support"], Lux: ["Support", "Mid"], Malphite: ["Top", "Jungle"], Malzahar: ["Mid"],
  Maokai: ["Jungle", "Support"], MasterYi: ["Jungle"], Mel: ["Support", "Mid"],
  Milio: ["Support"], MissFortune: ["ADC"], Mordekaiser: ["Top"], Morgana: ["Support"],
  Naafiri: ["Mid", "Jungle"], Nami: ["Support"], Nasus: ["Top"], Nautilus: ["Support"],
  Neeko: ["Mid", "Support"], Nidalee: ["Jungle"], Nilah: ["ADC"], Nocturne: ["Jungle"],
  Nunu: ["Jungle"], Olaf: ["Jungle", "Top"], Orianna: ["Mid"], Ornn: ["Top"],
  Pantheon: ["Support", "Top"], Poppy: ["Jungle", "Top"], Pyke: ["Support"],
  Qiyana: ["Mid", "Jungle"], Quinn: ["Top"], Rakan: ["Support"], Rammus: ["Jungle"],
  RekSai: ["Jungle"], Rell: ["Support"], Renata: ["Support"], Renekton: ["Top"],
  Rengar: ["Jungle"], Riven: ["Top"], Rumble: ["Top", "Jungle"], Ryze: ["Mid"],
  Samira: ["ADC"], Sejuani: ["Jungle"], Senna: ["Support", "ADC"],
  Seraphine: ["Support", "ADC"], Sett: ["Top", "Support"], Shaco: ["Jungle"], Shen: ["Top"],
  Shyvana: ["Jungle"], Singed: ["Top"], Sion: ["Top"], Sivir: ["ADC"], Skarner: ["Jungle"],
  Smolder: ["ADC"], Sona: ["Support"], Soraka: ["Support"], Swain: ["Support", "Mid"],
  Sylas: ["Mid", "Jungle"], Syndra: ["Mid"], TahmKench: ["Support", "Top"],
  Taliyah: ["Jungle", "Mid"], Talon: ["Mid", "Jungle"], Taric: ["Support"], Teemo: ["Top"],
  Thresh: ["Support"], Tristana: ["ADC", "Mid"], Trundle: ["Jungle", "Top"],
  Tryndamere: ["Top"], TwistedFate: ["Mid"], Twitch: ["ADC"], Udyr: ["Jungle"],
  Urgot: ["Top"], Varus: ["ADC"], Vayne: ["ADC", "Top"], Veigar: ["Mid", "Support"],
  Velkoz: ["Support", "Mid"], Vex: ["Mid"], Vi: ["Jungle"], Viego: ["Jungle"],
  Viktor: ["Mid"], Vladimir: ["Mid", "Top"], Volibear: ["Jungle", "Top"], Warwick: ["Jungle"],
  MonkeyKing: ["Jungle", "Top"], Xayah: ["ADC"], Xerath: ["Mid", "Support"],
  XinZhao: ["Jungle"], Yasuo: ["Mid", "Top"], Yone: ["Mid", "Top"], Yorick: ["Top"],
  Yunara: ["ADC"], Yuumi: ["Support"], Zaahen: ["Top", "Jungle"], Zac: ["Jungle"],
  Zed: ["Mid"], Zeri: ["ADC"], Ziggs: ["Mid", "ADC"], Zilean: ["Support"], Zoe: ["Mid"],
  Zyra: ["Support", "Mid"],
};

// Champion class tags — sourced live from Data Dragon (champion.tags), zero maintenance.
const CLASSES = ["Fighter", "Tank", "Mage", "Assassin", "Support", "Marksman"];

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

let state = {
  people: [], // populated live from Firestore's "people" collection — shared across everyone
  selectedPersonId: null, // local-only UI preference (which tab you're viewing), not shared
};

let championsById = {}; // id -> { id, name, image }
let championsByKey = {}; // numeric Data Dragon "key" (as a string) -> champion, for Spectator-V5's numeric championId
let championList = []; // sorted array of champions
let ddragonVersion = "";

let opggEditingId = null; // person id whose OP.GG link is mid-edit, or null
let opggDraftValue = ""; // in-progress (unsaved) text for that edit

const laneFilters = new Set(); // active "Lane" filter chips
const classFilters = new Set(); // active "Class" filter chips

let events = []; // populated live from Firestore's "events" collection — shared across everyone
let calendarViewDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1); // local-only, which month is showing
let selectedCalendarDate = null; // local-only, "YYYY-MM-DD" of the day expanded below the grid
let editingEventId = null; // event id whose fields are mid-edit, or null
let eventDraft = null; // { title, date, time, timezone, notes } — in-progress (unsaved) values while editing

let teamComps = []; // populated live from Firestore's "teamComps" collection — shared across everyone
let activeCompPickerKey = null; // "{compId}:{role}" of the champion picker currently expanded, or null
let compPickerSearch = ""; // search text for the currently expanded picker

let riotIdEditingId = null; // person id whose Riot ID is mid-edit, or null
let riotIdDraftValue = ""; // in-progress (unsaved) text for that edit
let matchesCache = {}; // personId -> { ranked, live, matches, loadError }
// One switch for both tabs: you're either reading someone's solo queue or their flex queue,
// and flipping tabs shouldn't silently change which one you're looking at. 420 solo, 440 flex.
let rankedQueueFilter = 420;
let matchesLoadingId = null; // person id currently fetching match data, or null
let statsCache = {}; // personId -> { games, wins, losses, kills, deaths, assists, roles, champions, loadError }
let statsLoadingId = null; // person id currently fetching stats, or null
let customGames = []; // populated live from Firestore's "customGames" collection — written by the local logger script

let notes = []; // populated live from Firestore's "notes" collection — shared across everyone
let gameReviews = []; // review notes pinned to one logged custom — "notes" docs of type "gameReview"
let reviews = []; // long-form coach/scrim writeups — "notes" docs of type "review"
let expandedReviewIds = new Set(); // which reviews are opened out; collapsed by default so the list stays scannable
let draftState = { blueTeamName: "Blue Team", redTeamName: "Red Team", actions: [] }; // shared live draft
let draftChampionSearch = ""; // search text for the draft champion picker

let draftResults = []; // saved drafts with their outcome — "notes" docs of type "draftResult"
let draftResultStatusText = "";
let draftResultStatusIsError = false;

let strategies = []; // populated live from Firestore's "notes" collection under type "strategy"
let scoutingId = null; // strategy id whose op.gg lobby is being fetched from Riot right now, or null
let strategyStatusText = ""; // last ask/scout message shown above the list ("" = nothing to say)
let strategyStatusIsError = false;

const els = {};

if (firebaseConfig.apiKey === "REPLACE_ME") {
  document.getElementById("loadingScreen").innerHTML =
    `<p style="color:#e05252">Firebase isn't configured yet — paste your real firebaseConfig values into app.js and reload.</p>`;
} else {
  init();
}

let dataStarted = false;
let resolveAuthReady;
const authReady = new Promise((r) => { resolveAuthReady = r; });
const LOADING_HTML = '<div class="spinner"></div><p>Loading champion data from Riot Data Dragon…</p>';

function showLockScreen() {
  const screen = document.getElementById("loadingScreen");
  screen.classList.remove("hidden");
  screen.innerHTML =
    '<p class="lock-note">🔒 This tool is team-private. Sign in (top right) with a team account to load it.</p>';
  els.app.classList.add("hidden");
}

async function init() {
  cacheEls();
  loadLocalUIState();
  configureMatchCache(localStorageMatchCache());
  bindStaticEvents();
  // Data loads only after sign-in — reads are team-private in the Firestore
  // rules, so subscribing signed-out would only collect permission errors.
  // startData() is kicked off by the auth listener in wireAuth().
  await authReady;
}

async function startData() {
  let championDataError = null;
  let peopleSnapshotError = null;
  let eventsSnapshotError = null;
  let teamCompsSnapshotError = null;
  let customGamesSnapshotError = null;
  let notesSnapshotError = null;
  let draftStateSnapshotError = null;

  const championPromise = loadChampionData().catch((err) => {
    championDataError = err;
  });

  // Rune and summoner-spell names for the scout profiles. Static CDN data, no Riot key and no
  // rate limit — and not fatal if it fails, since the ids just stay unresolved.
  loadStaticIndex().catch((err) => console.warn("Could not load rune/spell names", err));

  const firstPeopleSnapshotPromise = new Promise((resolve) => {
    onSnapshot(
      peopleCol,
      (snapshot) => {
        handlePeopleSnapshot(snapshot);
        resolve();
      },
      (err) => {
        peopleSnapshotError = err;
        resolve();
      }
    );
  });

  const firstEventsSnapshotPromise = new Promise((resolve) => {
    onSnapshot(
      eventsCol,
      (snapshot) => {
        handleEventsSnapshot(snapshot);
        resolve();
      },
      (err) => {
        eventsSnapshotError = err;
        resolve();
      }
    );
  });

  const firstTeamCompsSnapshotPromise = new Promise((resolve) => {
    onSnapshot(
      teamCompsCol,
      (snapshot) => {
        handleTeamCompsSnapshot(snapshot);
        resolve();
      },
      (err) => {
        teamCompsSnapshotError = err;
        resolve();
      }
    );
  });

  const firstCustomGamesSnapshotPromise = new Promise((resolve) => {
    onSnapshot(
      customGamesCol,
      (snapshot) => {
        handleCustomGamesSnapshot(snapshot);
        resolve();
      },
      (err) => {
        customGamesSnapshotError = err;
        resolve();
      }
    );
  });

  const firstNotesSnapshotPromise = new Promise((resolve) => {
    onSnapshot(
      notesCol,
      (snapshot) => {
        handleNotesSnapshot(snapshot);
        resolve();
      },
      (err) => {
        notesSnapshotError = err;
        resolve();
      }
    );
  });

  const firstDraftStateSnapshotPromise = new Promise((resolve) => {
    onSnapshot(
      draftStateDocRef,
      (snapshot) => {
        handleDraftStateSnapshot(snapshot);
        resolve();
      },
      (err) => {
        draftStateSnapshotError = err;
        resolve();
      }
    );
  });

  await Promise.all([
    championPromise,
    firstPeopleSnapshotPromise,
    firstEventsSnapshotPromise,
    firstTeamCompsSnapshotPromise,
    firstCustomGamesSnapshotPromise,
    firstNotesSnapshotPromise,
    firstDraftStateSnapshotPromise,
  ]);

  if (
    championDataError ||
    peopleSnapshotError ||
    eventsSnapshotError ||
    teamCompsSnapshotError ||
    customGamesSnapshotError ||
    notesSnapshotError ||
    draftStateSnapshotError
  ) {
    const snapErrs = [peopleSnapshotError, eventsSnapshotError, teamCompsSnapshotError,
      customGamesSnapshotError, notesSnapshotError, draftStateSnapshotError];
    const denied = snapErrs.some((e) => e && e.code === "permission-denied");
    document.getElementById("loadingScreen").innerHTML = denied
      ? `<p style="color:#e05252">${currentUser?.email || "This account"} is signed in but not on the team list. Ask the admin to add you on the Team tab, then reload.</p>`
      : `<p style="color:#e05252">${championDataError ? "Failed to load champion data." : "Failed to connect to the shared roster."} Check your internet connection and reload.</p>`;
    console.error(
      championDataError ||
        peopleSnapshotError ||
        eventsSnapshotError ||
        teamCompsSnapshotError ||
        customGamesSnapshotError ||
        notesSnapshotError ||
        draftStateSnapshotError
    );
    return;
  }

  // Re-render now that champion data and every shared collection are guaranteed loaded,
  // in case a snapshot arrived before champion data finished fetching.
  renderPeopleList();
  renderPoolTab();
  renderOverviewTab();
  renderCalendarTab();
  renderCompsTab();
  renderMatchesTab();
  renderStatsTab();
  renderCustomsTab();
  renderNotesTab();
  renderDraftTab();
  renderStrategyTab();

  document.getElementById("loadingScreen").classList.add("hidden");
  els.app.classList.remove("hidden");
}

function wireAuth() {
  els.signInBtn.addEventListener("click", async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      if (err.code !== "auth/popup-closed-by-user") alert(`Sign-in failed: ${err.message}`);
    }
  });
  els.signOutBtn.addEventListener("click", () => signOut(auth).catch((err) => console.error(err)));

  els.addTeamEmailForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = els.newTeamEmail.value.trim().toLowerCase();
    if (!email) return;
    // Doc id IS the email — that is what the rules' exists() check looks up.
    await setDoc(doc(allowlistCol, email), { addedBy: currentUser?.email || null, addedAt: new Date() });
    els.newTeamEmail.value = "";
  });

  // Whether an account may edit is decided by the Firestore rules, not here.
  // The page only reflects signed-in vs not; a signed-in account that is not
  // on the team list simply has its writes refused (and explainDenied says so).
  onAuthStateChanged(auth, (user) => {
    currentUser = user || null;
    const signedIn = !!currentUser;
    els.signInBtn.classList.toggle("hidden", signedIn);
    els.signOutBtn.classList.toggle("hidden", !signedIn);
    els.authWho.textContent = signedIn ? currentUser.email || "signed in" : "";
    els.authBox.title = signedIn ? "" : "Viewing is open; editing needs a team sign-in.";

    // First auth event decides whether the page shows the lock screen or
    // starts loading; later sign-outs tear everything down via reload, which
    // is the reliable way to drop six live snapshots and all their state.
    if (resolveAuthReady) { resolveAuthReady(); resolveAuthReady = null; }
    if (signedIn && !dataStarted) {
      dataStarted = true;
      document.getElementById("loadingScreen").innerHTML = LOADING_HTML;
      startData();
    } else if (!signedIn && dataStarted) {
      location.reload();
    } else if (!signedIn) {
      showLockScreen();
    }

    const isAdmin = signedIn && currentUser.email === ADMIN_EMAIL;
    els.teamTabBtn.classList.toggle("hidden", !isAdmin);
    if (isAdmin && !stopAllowlistWatch) {
      // Subscribe only as admin: the rules refuse this read to anyone else.
      stopAllowlistWatch = onSnapshot(allowlistCol, (snap) => {
        teamEmails = snap.docs.map((d) => d.id).sort();
        renderTeamTab();
      }, (err) => console.error("allowlist watch:", err));
    } else if (!isAdmin && stopAllowlistWatch) {
      stopAllowlistWatch();
      stopAllowlistWatch = null;
      teamEmails = [];
      renderTeamTab();
      // Don't leave a hidden tab as the active panel.
      if (document.getElementById("teamTab").classList.contains("active")) switchTab("pool");
    }
  });
}

let teamEmails = [];
let stopAllowlistWatch = null;

function renderTeamTab() {
  els.teamEmailList.innerHTML = "";
  for (const email of teamEmails) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = email;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      if (confirm(`Remove ${email}? They can still view, but no longer edit.`)) {
        deleteDoc(doc(allowlistCol, email));
      }
    });
    li.append(name, remove);
    els.teamEmailList.appendChild(li);
  }
  if (!teamEmails.length) {
    const li = document.createElement("li");
    li.textContent = "Nobody on the list yet — only the admin account can edit.";
    els.teamEmailList.appendChild(li);
  }
}

function cacheEls() {
  els.app = document.getElementById("app");
  els.patchBadge = document.getElementById("patchBadge");
  els.authBox = document.getElementById("authBox");
  els.authWho = document.getElementById("authWho");
  els.signInBtn = document.getElementById("signInBtn");
  els.signOutBtn = document.getElementById("signOutBtn");
  els.teamTabBtn = document.getElementById("teamTabBtn");
  els.addTeamEmailForm = document.getElementById("addTeamEmailForm");
  els.newTeamEmail = document.getElementById("newTeamEmail");
  els.teamEmailList = document.getElementById("teamEmailList");
  wireAuth();
  els.mobileMenuBtn = document.getElementById("mobileMenuBtn");
  els.sidebar = document.getElementById("sidebar");
  els.sidebarOverlay = document.getElementById("sidebarOverlay");
  els.addPersonForm = document.getElementById("addPersonForm");
  els.newPersonName = document.getElementById("newPersonName");
  els.newPersonOpgg = document.getElementById("newPersonOpgg");
  els.peopleList = document.getElementById("peopleList");
  els.noPersonSelected = document.getElementById("noPersonSelected");
  els.personPool = document.getElementById("personPool");
  els.selectedPersonName = document.getElementById("selectedPersonName");
  els.opggBox = document.getElementById("opggBox");
  els.poolGrid = document.getElementById("poolGrid");
  els.allChampionsGrid = document.getElementById("allChampionsGrid");
  els.championSearch = document.getElementById("championSearch");
  els.laneFilterChips = document.getElementById("laneFilterChips");
  els.classFilterChips = document.getElementById("classFilterChips");
  els.coverageWarnings = document.getElementById("coverageWarnings");
  els.coverageTable = document.getElementById("coverageTable");
  els.flexSection = document.getElementById("flexSection");
  els.championIconTemplate = document.getElementById("championIconTemplate");
  els.addEventForm = document.getElementById("addEventForm");
  els.newEventTitle = document.getElementById("newEventTitle");
  els.newEventDate = document.getElementById("newEventDate");
  els.newEventTime = document.getElementById("newEventTime");
  els.newEventNotes = document.getElementById("newEventNotes");
  els.calendarMonthLabel = document.getElementById("calendarMonthLabel");
  els.prevMonthBtn = document.getElementById("prevMonthBtn");
  els.nextMonthBtn = document.getElementById("nextMonthBtn");
  els.calendarGrid = document.getElementById("calendarGrid");
  els.attendanceSection = document.getElementById("attendanceSection");
  els.dayDetailPanel = document.getElementById("dayDetailPanel");
  els.dayDetailTitle = document.getElementById("dayDetailTitle");
  els.dayDetailEvents = document.getElementById("dayDetailEvents");
  els.addCompForm = document.getElementById("addCompForm");
  els.newCompName = document.getElementById("newCompName");
  els.compsList = document.getElementById("compsList");
  els.newPersonRiotId = document.getElementById("newPersonRiotId");
  els.noPersonSelectedMatches = document.getElementById("noPersonSelectedMatches");
  els.matchesContent = document.getElementById("matchesContent");
  els.matchesPersonName = document.getElementById("matchesPersonName");
  els.riotIdBox = document.getElementById("riotIdBox");
  els.loadMatchesBtn = document.getElementById("loadMatchesBtn");
  els.matchesStatus = document.getElementById("matchesStatus");
  els.rankedSection = document.getElementById("rankedSection");
  els.liveSection = document.getElementById("liveSection");
  els.historySection = document.getElementById("historySection");
  els.noPersonSelectedStats = document.getElementById("noPersonSelectedStats");
  els.statsContent = document.getElementById("statsContent");
  els.statsPersonName = document.getElementById("statsPersonName");
  els.refreshStatsBtn = document.getElementById("refreshStatsBtn");
  els.matchesQueueToggle = document.getElementById("matchesQueueToggle");
  els.statsQueueToggle = document.getElementById("statsQueueToggle");
  els.statsStatus = document.getElementById("statsStatus");
  els.statsSummarySection = document.getElementById("statsSummarySection");
  els.statsRolesSection = document.getElementById("statsRolesSection");
  els.statsChampionsSection = document.getElementById("statsChampionsSection");
  els.customsSummary = document.getElementById("customsSummary");
  els.customGamesList = document.getElementById("customGamesList");
  els.notesPersonSelect = document.getElementById("notesPersonSelect");
  els.noPersonSelectedNotes = document.getElementById("noPersonSelectedNotes");
  els.playerNotesContent = document.getElementById("playerNotesContent");
  els.notesPersonName = document.getElementById("notesPersonName");
  els.addPlayerNoteForm = document.getElementById("addPlayerNoteForm");
  els.newPlayerNoteText = document.getElementById("newPlayerNoteText");
  els.newPlayerNoteAuthor = document.getElementById("newPlayerNoteAuthor");
  els.playerNotesList = document.getElementById("playerNotesList");
  els.addDraftNoteForm = document.getElementById("addDraftNoteForm");
  els.newDraftNoteText = document.getElementById("newDraftNoteText");
  els.newDraftNoteAuthor = document.getElementById("newDraftNoteAuthor");
  els.draftNotesList = document.getElementById("draftNotesList");
  els.addReviewForm = document.getElementById("addReviewForm");
  els.newReviewTitle = document.getElementById("newReviewTitle");
  els.newReviewFile = document.getElementById("newReviewFile");
  els.reviewFileStatus = document.getElementById("reviewFileStatus");
  els.newReviewText = document.getElementById("newReviewText");
  els.newReviewAuthor = document.getElementById("newReviewAuthor");
  els.reviewsList = document.getElementById("reviewsList");
  els.blueTeamNameInput = document.getElementById("blueTeamNameInput");
  els.redTeamNameInput = document.getElementById("redTeamNameInput");
  els.draftPhaseLabel = document.getElementById("draftPhaseLabel");
  els.draftTurnLabel = document.getElementById("draftTurnLabel");
  els.undoDraftBtn = document.getElementById("undoDraftBtn");
  els.resetDraftBtn = document.getElementById("resetDraftBtn");
  els.draftOurSide = document.getElementById("draftOurSide");
  els.saveDraftWinBtn = document.getElementById("saveDraftWinBtn");
  els.saveDraftLossBtn = document.getElementById("saveDraftLossBtn");
  els.draftResultStatus = document.getElementById("draftResultStatus");
  els.draftHistorySummary = document.getElementById("draftHistorySummary");
  els.draftHistoryList = document.getElementById("draftHistoryList");
  els.draftChampionSearch = document.getElementById("draftChampionSearch");
  els.draftChampionGrid = document.getElementById("draftChampionGrid");
  els.blueBoardLabel = document.getElementById("blueBoardLabel");
  els.redBoardLabel = document.getElementById("redBoardLabel");
  els.blueBans = document.getElementById("blueBans");
  els.redBans = document.getElementById("redBans");
  els.bluePicks = document.getElementById("bluePicks");
  els.redPicks = document.getElementById("redPicks");
  els.askStrategyForm = document.getElementById("askStrategyForm");
  els.newStrategyQuestion = document.getElementById("newStrategyQuestion");
  els.newStrategyOpgg = document.getElementById("newStrategyOpgg");
  els.newStrategyCategory = document.getElementById("newStrategyCategory");
  els.newStrategySampleSize = document.getElementById("newStrategySampleSize");
  els.newStrategyQueueScope = document.getElementById("newStrategyQueueScope");
  els.newStrategyAuthor = document.getElementById("newStrategyAuthor");
  els.strategyStatus = document.getElementById("strategyStatus");
  els.strategyList = document.getElementById("strategyList");
}

function bindStaticEvents() {
  els.mobileMenuBtn.addEventListener("click", () => setSidebarOpen(true));
  els.sidebarOverlay.addEventListener("click", () => setSidebarOpen(false));

  els.addPersonForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = els.newPersonName.value.trim();
    if (!name) return;
    const opgg = els.newPersonOpgg.value.trim();
    const riotId = els.newPersonRiotId.value.trim();
    addPerson(name, opgg, riotId);
    els.newPersonName.value = "";
    els.newPersonOpgg.value = "";
    els.newPersonRiotId.value = "";
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  els.championSearch.addEventListener("input", () => renderAllChampionsGrid());

  renderFilterChips(els.laneFilterChips, LANES, laneFilters);
  renderFilterChips(els.classFilterChips, CLASSES, classFilters);

  els.addEventForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = els.newEventTitle.value.trim();
    const date = els.newEventDate.value;
    if (!title || !date) return;
    const time = els.newEventTime.value;
    const notes = els.newEventNotes.value.trim();
    // Times are entered in whatever zone the author's machine is in — no picker. The zone is
    // stored with the event so other people's browsers can shift it to their own clock.
    addEvent(title, date, time, DEFAULT_TIMEZONE, notes);
    els.newEventTitle.value = "";
    els.newEventTime.value = "";
    els.newEventNotes.value = "";
  });

  els.prevMonthBtn.addEventListener("click", () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
    renderCalendarTab();
  });

  els.nextMonthBtn.addEventListener("click", () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
    renderCalendarTab();
  });

  els.addCompForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = els.newCompName.value.trim();
    if (!name) return;
    addTeamComp(name);
    els.newCompName.value = "";
  });

  els.loadMatchesBtn.addEventListener("click", () => {
    const person = getSelectedPerson();
    if (person) loadMatchData(person);
  });

  els.refreshStatsBtn.addEventListener("click", () => {
    const person = getSelectedPerson();
    if (person) loadStatsData(person);
  });

  // The two toggles are one control drawn twice — picking Flex on Stats means Matches is on
  // Flex too when you get there.
  [els.matchesQueueToggle, els.statsQueueToggle].forEach((toggle) => {
    toggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-queue]");
      if (!btn) return;
      rankedQueueFilter = Number(btn.dataset.queue);
      syncQueueToggles();
      renderMatchesTab();
      renderStatsTab();
    });
  });

  // The dropdown drives the same selection the sidebar does, so the two never disagree and
  // the other player-scoped tabs follow along.
  els.notesPersonSelect.addEventListener("change", () => {
    selectPerson(els.notesPersonSelect.value || null);
  });

  els.addPlayerNoteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const person = getSelectedPerson();
    if (!person) return;
    const text = els.newPlayerNoteText.value.trim();
    if (!text) return;
    const author = els.newPlayerNoteAuthor.value.trim();
    addNote("player", person.id, author, text);
    els.newPlayerNoteText.value = "";
  });

  els.addDraftNoteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.newDraftNoteText.value.trim();
    if (!text) return;
    const author = els.newDraftNoteAuthor.value.trim();
    addNote("draft", null, author, text);
    els.newDraftNoteText.value = "";
  });

  // Reading the file in the browser and dropping it into the textarea keeps the whole feature
  // on Firestore — no Storage bucket, no upload URLs, and the text stays editable before it
  // is posted. The title auto-fills from the filename only while it's still empty, so it
  // never overwrites something already typed.
  els.newReviewFile.addEventListener("change", async () => {
    const file = els.newReviewFile.files?.[0];
    if (!file) return;
    if (file.size > 900_000) {
      els.reviewFileStatus.textContent = "That file is too big (Firestore caps a document at 1MB).";
      els.newReviewFile.value = "";
      return;
    }
    try {
      els.newReviewText.value = await file.text();
      if (!els.newReviewTitle.value.trim()) {
        els.newReviewTitle.value = file.name.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ");
      }
      els.reviewFileStatus.textContent = `Loaded ${file.name} — edit below if you like, then post.`;
    } catch {
      els.reviewFileStatus.textContent = "Could not read that file.";
    }
  });

  els.addReviewForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = els.newReviewTitle.value.trim();
    const text = els.newReviewText.value.trim();
    if (!title || !text) return;
    addReview(title, els.newReviewAuthor.value.trim(), text);
    els.newReviewTitle.value = "";
    els.newReviewText.value = "";
    els.newReviewFile.value = "";
    els.reviewFileStatus.textContent = "";
  });

  els.blueTeamNameInput.addEventListener("change", () => {
    saveDraftState({ blueTeamName: els.blueTeamNameInput.value.trim() || "Blue Team" });
  });
  els.redTeamNameInput.addEventListener("change", () => {
    saveDraftState({ redTeamName: els.redTeamNameInput.value.trim() || "Red Team" });
  });

  els.undoDraftBtn.addEventListener("click", () => {
    if (draftState.actions.length === 0) return;
    saveDraftState({ actions: draftState.actions.slice(0, -1) });
  });

  els.resetDraftBtn.addEventListener("click", () => {
    if (confirm("Reset the draft? This clears all bans and picks.")) {
      saveDraftState({ actions: [] });
    }
  });

  els.draftChampionSearch.addEventListener("input", () => {
    draftChampionSearch = els.draftChampionSearch.value;
    renderDraftChampionGrid();
  });

  els.saveDraftWinBtn.addEventListener("click", () => saveDraftResult(els.draftOurSide.value, true));
  els.saveDraftLossBtn.addEventListener("click", () => saveDraftResult(els.draftOurSide.value, false));

  STRATEGY_CATEGORIES.forEach((category) => {
    const opt = document.createElement("option");
    opt.value = category;
    opt.textContent = category;
    els.newStrategyCategory.appendChild(opt);
  });

  SAMPLE_SIZES.forEach((size) => {
    const opt = document.createElement("option");
    opt.value = String(size);
    opt.textContent = `${size} ranked games`;
    els.newStrategySampleSize.appendChild(opt);
  });
  els.newStrategySampleSize.value = String(RANKED_SAMPLE_TARGET);

  Object.entries(QUEUE_SCOPES).forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    els.newStrategyQueueScope.appendChild(opt);
  });

  els.askStrategyForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = els.newStrategyQuestion.value.trim();
    if (!question) return;
    const opggUrl = els.newStrategyOpgg.value.trim();
    const category = els.newStrategyCategory.value;
    const author = els.newStrategyAuthor.value.trim();
    askStrategy(question, category, opggUrl, author, Number(els.newStrategySampleSize.value), els.newStrategyQueueScope.value);
    els.newStrategyQuestion.value = "";
    els.newStrategyOpgg.value = "";
  });
}

function renderFilterChips(container, options, activeSet) {
  container.innerHTML = "";
  options.forEach((option) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-chip";
    btn.textContent = option;
    btn.addEventListener("click", () => {
      if (activeSet.has(option)) activeSet.delete(option);
      else activeSet.add(option);
      btn.classList.toggle("active", activeSet.has(option));
      renderAllChampionsGrid();
    });
    container.appendChild(btn);
  });
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("poolTab").classList.toggle("active", tab === "pool");
  document.getElementById("overviewTab").classList.toggle("active", tab === "overview");
  document.getElementById("calendarTab").classList.toggle("active", tab === "calendar");
  document.getElementById("compsTab").classList.toggle("active", tab === "comps");
  document.getElementById("matchesTab").classList.toggle("active", tab === "matches");
  document.getElementById("statsTab").classList.toggle("active", tab === "stats");
  document.getElementById("customsTab").classList.toggle("active", tab === "customs");
  document.getElementById("notesTab").classList.toggle("active", tab === "notes");
  document.getElementById("reviewsTab").classList.toggle("active", tab === "reviews");
  document.getElementById("draftTab").classList.toggle("active", tab === "draft");
  document.getElementById("strategyTab").classList.toggle("active", tab === "strategy");
  document.getElementById("teamTab").classList.toggle("active", tab === "team");
  if (tab === "overview") renderOverviewTab();
  if (tab === "calendar") renderCalendarTab();
  if (tab === "comps") renderCompsTab();
  if (tab === "matches") renderMatchesTab();
  if (tab === "stats") renderStatsTab();
  if (tab === "customs") renderCustomsTab();
  if (tab === "notes") renderNotesTab();
  if (tab === "reviews") renderReviewsTab();
  if (tab === "draft") renderDraftTab();
  if (tab === "strategy") renderStrategyTab();
}

/* ---------- Shared roster (Firestore) ---------- */

function handlePeopleSnapshot(snapshot) {
  state.people = snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (state.selectedPersonId && !state.people.some((p) => p.id === state.selectedPersonId)) {
    state.selectedPersonId = null;
    saveLocalUIState();
  }

  renderPeopleList();
  renderPoolTab();
  renderOverviewTab();
  renderCalendarTab(); // attendee names/lists depend on the current people list
  renderMatchesTab();
  renderStatsTab();
  renderNotesTab();
}

function handleEventsSnapshot(snapshot) {
  events = snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));

  renderCalendarTab();
}

function handleTeamCompsSnapshot(snapshot) {
  teamComps = snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  renderCompsTab();
}

function handleCustomGamesSnapshot(snapshot) {
  customGames = snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    // The TLS Tourney Stat Tool writes into this same collection behind an org marker, because
    // the security rules reject a new collection. Games belonging to another org are theirs.
    .filter((g) => !g.org)
    .sort((a, b) => {
      const aTime = a.capturedAt?.seconds ?? 0;
      const bTime = b.capturedAt?.seconds ?? 0;
      return bTime - aTime;
    });

  renderCustomsTab();
}

function handleNotesSnapshot(snapshot) {
  const all = snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const aTime = a.createdAt?.seconds ?? 0;
      const bTime = b.createdAt?.seconds ?? 0;
      return bTime - aTime;
    });

  // One collection, several features. The Notes tab reads "player" and "draft"; everything
  // else claims its own type. Splitting here keeps every renderer downstream unaware of the
  // sharing, which exists because the Firestore rules name collections one by one.
  notes = all.filter((n) => n.type === "player" || n.type === "draft");
  strategies = all.filter((n) => n.type === "strategy");
  draftResults = all.filter((n) => n.type === "draftResult");
  gameReviews = all.filter((n) => n.type === "gameReview");
  reviews = all.filter((n) => n.type === "review");

  renderNotesTab();
  renderReviewsTab();
  renderStrategyTab();
  renderDraftHistory();
  renderCustomsTab();
}

function handleDraftStateSnapshot(snapshot) {
  if (snapshot.exists()) {
    const data = snapshot.data();
    draftState = {
      blueTeamName: data.blueTeamName || "Blue Team",
      redTeamName: data.redTeamName || "Red Team",
      actions: Array.isArray(data.actions) ? data.actions : [],
    };
  } else {
    draftState = { blueTeamName: "Blue Team", redTeamName: "Red Team", actions: [] };
  }

  renderDraftTab();
}

/* ---------- Local-only UI persistence ---------- */

function loadLocalUIState() {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.selectedPersonId !== "undefined") {
        state.selectedPersonId = parsed.selectedPersonId;
      }
    }
  } catch (err) {
    console.warn("Could not load saved UI state", err);
  }
}

function saveLocalUIState() {
  localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ selectedPersonId: state.selectedPersonId }));
}

// Match summaries are cached per browser rather than in Firestore: they are derived data
// anyone can re-fetch, and keeping them local means a scout costs Riot requests only for
// games that are actually new. Riot's rate limit, not storage, is the scarce resource.
function localStorageMatchCache() {
  return {
    load() {
      const raw = localStorage.getItem(MATCH_CACHE_KEY);
      return raw ? JSON.parse(raw) : {};
    },
    save(entries) {
      const keys = Object.keys(entries);
      const trimmed =
        keys.length > MATCH_CACHE_LIMIT
          ? Object.fromEntries(keys.slice(keys.length - MATCH_CACHE_LIMIT).map((k) => [k, entries[k]]))
          : entries;
      try {
        localStorage.setItem(MATCH_CACHE_KEY, JSON.stringify(trimmed));
      } catch (err) {
        // A full quota is not worth failing a scout over — drop the cache and carry on.
        console.warn("Match cache could not be saved; clearing it.", err);
        localStorage.removeItem(MATCH_CACHE_KEY);
      }
    },
  };
}

/* ---------- Data Dragon ---------- */

async function loadChampionData() {
  const versionsRes = await fetch(`${DDRAGON_BASE}/api/versions.json`);
  const versions = await versionsRes.json();
  ddragonVersion = versions[0];
  els.patchBadge.textContent = `Patch ${ddragonVersion}`;

  const champRes = await fetch(`${DDRAGON_BASE}/cdn/${ddragonVersion}/data/en_US/champion.json`);
  const champData = await champRes.json();

  championList = Object.values(champData.data)
    .filter((c) => !c.id.startsWith("Jade_"))
    .map((c) => ({
      id: c.id,
      name: c.name,
      image: `${DDRAGON_BASE}/cdn/${ddragonVersion}/img/champion/${c.image.full}`,
      tags: c.tags || [],
      key: c.key,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  championsById = {};
  championsByKey = {};
  championList.forEach((c) => {
    championsById[c.id] = c;
    championsByKey[c.key] = c;
  });
}

function findChampionByName(championName) {
  if (!championName) return null;
  if (championsById[championName]) return championsById[championName];
  const lower = championName.toLowerCase();
  return (
    championList.find((c) => c.id.toLowerCase() === lower) ||
    // Riot's match data uses the id form ("MonkeyKing", "Kaisa"), but a human writing a
    // strategy uses the display name ("Wukong", "Kai'Sa") — both should resolve.
    championList.find((c) => c.name.toLowerCase() === lower) ||
    championList.find((c) => c.name.toLowerCase().replace(/[^a-z]/g, "") === lower.replace(/[^a-z]/g, "")) ||
    null
  );
}

function findChampionByKey(championKey) {
  return championsByKey[String(championKey)] || null;
}

/* ---------- People ---------- */

async function addPerson(name, opgg, riotId) {
  const id = crypto.randomUUID();
  state.selectedPersonId = id;
  saveLocalUIState();
  try {
    await setDoc(personDoc(id), {
      name,
      opgg: normalizeUrl(opgg),
      pool: [],
      riotId: riotId ? riotId.trim() : null,
      puuid: null,
    });
  } catch (err) {
    console.error(err);
    alert("Could not add that player — check your connection and try again.");
    if (state.selectedPersonId === id) {
      state.selectedPersonId = null;
      saveLocalUIState();
    }
  }
}

function normalizeUrl(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function removePerson(id) {
  try {
    await deleteDoc(personDoc(id));
  } catch (err) {
    console.error(err);
    alert("Could not remove that player — check your connection and try again.");
  }
}

function selectPerson(id) {
  state.selectedPersonId = id;
  saveLocalUIState();
  renderPeopleList();
  renderPoolTab();
  renderMatchesTab();
  renderStatsTab();
  renderNotesTab();
  setSidebarOpen(false);
}

function setSidebarOpen(open) {
  els.sidebar.classList.toggle("open", open);
  els.sidebarOverlay.classList.toggle("visible", open);
}

function getSelectedPerson() {
  return state.people.find((p) => p.id === state.selectedPersonId) || null;
}

async function savePool(person, nextPool) {
  try {
    await updateDoc(personDoc(person.id), { pool: nextPool });
  } catch (err) {
    console.error(err);
    alert("Could not save that change — check your connection and try again.");
  }
}

function updatePoolEntry(person, championId, changes) {
  const nextPool = person.pool.map((p) => (p.championId === championId ? { ...p, ...changes } : p));
  savePool(person, nextPool);
}

// Pool entries used to carry a single `role`; they now carry several in `roles`. Every reader
// goes through here so pools written before the change keep working — there is no migration
// pass, an old entry just reads as a one-role list until someone edits it.
function entryRoles(entry) {
  if (Array.isArray(entry.roles)) return entry.roles;
  return entry.role ? [entry.role] : [];
}

function entryHasRole(entry, role) {
  return entryRoles(entry).includes(role);
}

function toggleEntryRole(person, entry, role) {
  const current = entryRoles(entry);
  const next = current.includes(role) ? current.filter((r) => r !== role) : [...current, role];
  // Store in ROLES order rather than click order, so two people who picked the same roles get
  // the same array and the UI reads consistently.
  const ordered = ROLES.filter((r) => next.includes(r));
  // `role` is kept in sync with the first entry: an older client still open in another tab
  // reads a sensible single value instead of undefined.
  updatePoolEntry(person, entry.championId, { roles: ordered, role: ordered[0] || null });
}

/* ---------- Events ---------- */

async function addEvent(title, date, time, timezone, notes) {
  const id = crypto.randomUUID();
  selectedCalendarDate = date;
  try {
    await setDoc(eventDoc(id), {
      title,
      date,
      time: time || null,
      timezone: timezone || DEFAULT_TIMEZONE,
      notes: notes || null,
      attendees: [],
    });
  } catch (err) {
    console.error(err);
    alert("Could not add that event — check your connection and try again.");
  }
}

async function updateEvent(id, changes) {
  try {
    await updateDoc(eventDoc(id), changes);
  } catch (err) {
    console.error(err);
    alert("Could not save that event — check your connection and try again.");
  }
}

async function deleteEvent(id) {
  try {
    await deleteDoc(eventDoc(id));
  } catch (err) {
    console.error(err);
    alert("Could not delete that event — check your connection and try again.");
  }
}

async function toggleAttendee(event, personId) {
  const attendees = event.attendees || [];
  const nextAttendees = attendees.includes(personId)
    ? attendees.filter((id) => id !== personId)
    : [...attendees, personId];
  try {
    await updateDoc(eventDoc(event.id), { attendees: nextAttendees });
  } catch (err) {
    console.error(err);
    alert("Could not update attendance — check your connection and try again.");
  }
}

/* ---------- Team comps ---------- */

async function addTeamComp(name) {
  const id = crypto.randomUUID();
  try {
    await setDoc(teamCompDoc(id), {
      name,
      roles: { Top: [], Jungle: [], Mid: [], ADC: [], Support: [] },
    });
  } catch (err) {
    console.error(err);
    alert("Could not add that team comp — check your connection and try again.");
  }
}

async function deleteTeamComp(id) {
  try {
    await deleteDoc(teamCompDoc(id));
  } catch (err) {
    console.error(err);
    alert("Could not delete that team comp — check your connection and try again.");
  }
}

async function toggleCompChampion(comp, role, championId) {
  const current = comp.roles?.[role] || [];
  const next = current.includes(championId)
    ? current.filter((id) => id !== championId)
    : [...current, championId];
  try {
    await updateDoc(teamCompDoc(comp.id), { [`roles.${role}`]: next });
  } catch (err) {
    console.error(err);
    alert("Could not update that team comp — check your connection and try again.");
  }
}

/* ---------- Notes ---------- */

async function addNote(type, personId, author, text) {
  const id = crypto.randomUUID();
  try {
    await setDoc(noteDoc(id), {
      type,
      personId: personId || null,
      author: author || null,
      text,
      // A concrete client Date (not serverTimestamp()) so newly-added notes sort correctly
      // right away, instead of briefly showing as a null placeholder until the server confirms.
      createdAt: new Date(),
    });
  } catch (err) {
    console.error(err);
    alert("Could not add that note — check your connection and try again.");
  }
}

// Pinned to the custom game's document id, which the logger sets to the Riot gameId — so a
// review survives re-logging the same game and never drifts onto a different one.
async function addGameReview(gameId, author, text) {
  const id = crypto.randomUUID();
  try {
    await setDoc(noteDoc(id), {
      type: "gameReview",
      gameId,
      author: author || null,
      text,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error(err);
    alert("Could not save that review note — check your connection and try again.");
  }
}

async function deleteNote(id) {
  try {
    await deleteDoc(noteDoc(id));
  } catch (err) {
    console.error(err);
    alert("Could not delete that note — check your connection and try again.");
  }
}

/* ---------- Draft results (the loop from a draft back to whether it worked) ---------- */

// A draft on its own is a plan; a draft with an outcome attached is evidence. Saving one
// freezes the current board — champions, sides and who we were — so the record survives the
// next reset. Stored in the notes collection under type "draftResult", like everything else
// that would otherwise need a new Firestore collection.
async function saveDraftResult(ourSide, won) {
  if (draftState.actions.length === 0) {
    setDraftResultStatus("Nothing to record — the board is empty.", true);
    return;
  }

  const id = crypto.randomUUID();
  try {
    await setDoc(noteDoc(id), {
      type: "draftResult",
      actions: [...draftState.actions],
      blueTeamName: draftState.blueTeamName,
      redTeamName: draftState.redTeamName,
      ourSide,
      won,
      complete: draftState.actions.length >= DRAFT_SEQUENCE.length,
      createdAt: new Date(),
    });
    setDraftResultStatus(`Recorded as a ${won ? "win" : "loss"} on ${ourSide}.`, false);
  } catch (err) {
    console.error(err);
    setDraftResultStatus("Could not save that result — check your connection and try again.", true);
  }
}

async function deleteDraftResult(id) {
  try {
    await deleteDoc(noteDoc(id));
  } catch (err) {
    console.error(err);
    setDraftResultStatus("Could not delete that result.", true);
  }
}

function setDraftResultStatus(text, isError) {
  draftResultStatusText = text;
  draftResultStatusIsError = Boolean(isError);
  renderDraftHistory();
}

// What the saved drafts add up to: our record, our record by side, and which champions show
// up in wins and losses — ours and theirs.
function draftResultStats() {
  const games = draftResults.length;
  const wins = draftResults.filter((r) => r.won).length;
  const bySide = { blue: { games: 0, wins: 0 }, red: { games: 0, wins: 0 } };
  const ours = new Map();
  const theirs = new Map();

  const bump = (map, championId, won) => {
    if (!map.has(championId)) map.set(championId, { games: 0, wins: 0 });
    const row = map.get(championId);
    row.games++;
    if (won) row.wins++;
  };

  draftResults.forEach((result) => {
    const side = result.ourSide === "red" ? "red" : "blue";
    bySide[side].games++;
    if (result.won) bySide[side].wins++;

    const parts = decomposeDraft(result.actions);
    const ourPicks = side === "blue" ? parts.bluePicks : parts.redPicks;
    const theirPicks = side === "blue" ? parts.redPicks : parts.bluePicks;
    ourPicks.forEach((id) => bump(ours, id, result.won));
    // A champion on the other side is recorded by whether *we* won, so a high number here
    // means it keeps beating us.
    theirPicks.forEach((id) => bump(theirs, id, !result.won));
  });

  const rank = (map) =>
    [...map.entries()]
      .map(([championId, row]) => ({ championId, ...row, winRate: row.games ? Math.round((row.wins / row.games) * 100) : 0 }))
      .sort((a, b) => b.games - a.games || b.winRate - a.winRate);

  return { games, wins, losses: games - wins, bySide, ours: rank(ours), theirs: rank(theirs) };
}

/* ---------- Strategy (questions for Claude + op.gg lobby scouting) ---------- */

// Nothing that would overrun Riot's limit happens without being asked first. The numbers are
// spelled out rather than summarised, because "this might be slow" is not a decision anyone
// can make — "310 requests against a budget of 100 every 2 minutes" is.
function confirmRiotSpend(playerCount, sampleSize) {
  const cost = estimateLobbyCost(playerCount, { target: sampleSize });
  const budget = requestBudget();
  if (cost.worst <= budget.remaining) return true;

  const windows = Math.ceil(cost.worst / RATE_LIMIT_PER_WINDOW);
  return confirm(
    `Polling ${playerCount} players × ${sampleSize} ranked games needs about ` +
      `${cost.best}–${cost.worst} Riot requests.\n\n` +
      `The key allows ${RATE_LIMIT_PER_WINDOW} every 2 minutes and ${budget.remaining} are left in this window` +
      `${budget.used ? ` (${budget.used} already used, clears in ${budget.resetInSeconds}s)` : ""}.\n\n` +
      `This will hit the limit and stop partway — roughly ${windows} rounds of 2 minutes to finish it all. ` +
      `Games already polled are cached, so anything it gets through is not lost and a retry resumes cheaply.\n\n` +
      `Continue anyway?`
  );
}

async function askStrategy(question, category, opggUrl, author, sampleSize = RANKED_SAMPLE_TARGET, queueScope = "both") {
  const id = crypto.randomUUID();
  const parsed = parseOpggMultiSearch(opggUrl);

  if (parsed.players.length > 0 && !confirmRiotSpend(parsed.players.length, sampleSize)) {
    setStrategyStatus("Question saved without polling the lobby — use Scout lobby on the card when you're ready.", false);
    await saveStrategyQuestion(id, question, category, opggUrl, author, sampleSize, queueScope);
    return;
  }

  const saved = await saveStrategyQuestion(id, question, category, opggUrl, author, sampleSize, queueScope);
  if (!saved) return;

  if (parsed.players.length > 0) {
    scoutStrategy({ id, opggUrl, sampleSize, queueScope });
  }
}

async function saveStrategyQuestion(id, question, category, opggUrl, author, sampleSize, queueScope) {
  try {
    await setDoc(strategyDoc(id), {
      type: "strategy",
      question,
      category: category || "General",
      opggUrl: opggUrl || null,
      askedBy: author || null,
      status: "pending",
      answer: null,
      answeredAt: null,
      sampleSize: sampleSize || RANKED_SAMPLE_TARGET,
      queueScope: queueScope || "both",
      // A concrete client Date (not serverTimestamp()) so a new question sorts to the top
      // immediately instead of sitting as a null placeholder until the server confirms.
      createdAt: new Date(),
      scoutJson: null,
      scoutError: null,
    });
    return true;
  } catch (err) {
    console.error(err);
    setStrategyStatus("Could not save that question — check your connection and try again.", true);
    return false;
  }
}

async function deleteStrategy(id) {
  try {
    await deleteDoc(strategyDoc(id));
  } catch (err) {
    console.error(err);
    setStrategyStatus("Could not delete that question — check your connection and try again.", true);
  }
}

function setStrategyStatus(text, isError) {
  strategyStatusText = text;
  strategyStatusIsError = Boolean(isError);
  renderStrategyTab();
}

// Pulls rank + recent champion pool for every player in the link, so the answer is written
// against real data instead of guesses. The result is stored as a JSON string rather than a
// nested Firestore map — it is only ever read back whole, and one string keeps the shape free
// to change without a migration.
async function scoutStrategy(entry, { alreadyConfirmed = false } = {}) {
  const parsed = parseOpggMultiSearch(entry.opggUrl);
  if (parsed.players.length === 0) {
    setStrategyStatus("No players found in that op.gg link.", true);
    return;
  }

  const sampleSize = entry.sampleSize || RANKED_SAMPLE_TARGET;
  if (!alreadyConfirmed && !confirmRiotSpend(parsed.players.length, sampleSize)) {
    setStrategyStatus("Left alone — nothing was requested from Riot.", false);
    return;
  }

  const queueScope = entry.queueScope || "both";
  scoutingId = entry.id;
  setStrategyStatus(
    `Polling ${parsed.players.length} player${parsed.players.length === 1 ? "" : "s"} — up to ` +
      `${sampleSize} ranked games each (${QUEUE_SCOPES[queueScope] || QUEUE_SCOPES.both}).`,
    false
  );

  try {
    const scout = await scoutLobby(entry.opggUrl, state.people, {
      target: sampleSize,
      queueScope,
      onProgress: ({ index, total, riotId, stage, found }) => {
        const position = `Player ${index + 1} of ${total}`;
        setStrategyStatus(
          stage === "scanning"
            ? `${position} — ${riotId}: ${found} ranked games found…`
            : `${position} — ${riotId}${stage === "done" ? " done" : "…"}`,
          false
        );
      },
      // Written back after each player, so a rate limit or a closed tab near the end still
      // leaves the players already polled on the card.
      onPlayer: async (_player, done) => {
        const partial = {
          region: parsed.region,
          sampleTarget: sampleSize,
          partial: true,
          fetchedAt: new Date().toISOString(),
          players: done,
        };
        await updateDoc(strategyDoc(entry.id), { scoutJson: JSON.stringify(partial) }).catch((err) =>
          console.warn("Could not save partial scout progress", err)
        );
      },
    });
    await updateDoc(strategyDoc(entry.id), { scoutJson: JSON.stringify(scout), scoutError: null });

    const failed = scout.players.filter((p) => p.error).length;
    setStrategyStatus(
      failed === 0
        ? "Lobby scouted — Claude can see the ranks and champion pools now."
        : `Lobby scouted, but ${failed} player${failed === 1 ? "" : "s"} could not be looked up (see the card).`,
      failed > 0
    );
  } catch (err) {
    console.error(err);
    const done = (err.players || []).length;
    const message = err.rateLimited
      ? `${err.message} ${done} of ${parsed.players.length} players were polled and saved — ` +
        `press Scout lobby again in about ${requestBudget().resetInSeconds}s and it picks up from the cache.`
      : err.message || "Something went wrong scouting that lobby.";
    try {
      await updateDoc(strategyDoc(entry.id), { scoutError: message });
    } catch (writeErr) {
      console.error(writeErr);
    }
    setStrategyStatus(message, true);
  } finally {
    scoutingId = null;
    renderStrategyTab();
  }
}

function parseScout(entry) {
  if (!entry.scoutJson) return null;
  try {
    return JSON.parse(entry.scoutJson);
  } catch (err) {
    console.warn("Could not read the stored scout for strategy", entry.id, err);
    return null;
  }
}

// The plain-text version of a question, for pasting to Claude somewhere other than this app
// (Discord, a chat window) when you'd rather not wait for the answer to land here.
function strategyBriefText(entry) {
  const lines = [`Strategy question (${entry.category || "General"}): ${entry.question}`];
  if (entry.opggUrl) lines.push(`op.gg: ${entry.opggUrl}`);
  lines.push(`Strategy id: ${entry.id}`);

  const scout = parseScout(entry);
  if (scout) {
    lines.push("", `Lobby scouted from Riot (up to ${scout.sampleTarget || RANKED_SAMPLE_TARGET} ranked games each, ${scout.queues || "solo + flex"}):`);
    scout.players.forEach((p) => lines.push(`- ${formatScoutedPlayer(p)}`));
  }

  return lines.join("\n");
}

/* ---------- Draft simulator ---------- */

async function saveDraftState(changes) {
  const next = { ...draftState, ...changes };
  try {
    await setDoc(draftStateDocRef, next, { merge: true });
  } catch (err) {
    console.error(err);
    alert("Could not update the draft — check your connection and try again.");
  }
}

function pickDraftChampion(championId) {
  const index = draftState.actions.length;
  if (index >= DRAFT_SEQUENCE.length) return;
  if (draftState.actions.includes(championId)) return;
  saveDraftState({ actions: [...draftState.actions, championId] });
}

/* ---------- Rendering: People list ---------- */

function renderPeopleList() {
  els.peopleList.innerHTML = "";
  state.people.forEach((person) => {
    const li = document.createElement("li");
    li.className = "person-row" + (person.id === state.selectedPersonId ? " selected" : "");

    const nameWrap = document.createElement("div");
    nameWrap.className = "person-name";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = person.name;
    const countSpan = document.createElement("span");
    countSpan.className = "pool-count";
    countSpan.textContent = `${person.pool.length} champion${person.pool.length === 1 ? "" : "s"}`;
    nameWrap.append(nameSpan, countSpan);

    if (person.opgg) {
      const link = document.createElement("a");
      link.className = "opgg-link";
      link.href = person.opgg;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "OP.GG ↗";
      link.addEventListener("click", (e) => e.stopPropagation());
      nameWrap.appendChild(link);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-person";
    removeBtn.textContent = "×";
    removeBtn.title = `Remove ${person.name}`;
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Remove ${person.name} and their champion pool?`)) removePerson(person.id);
    });

    li.append(nameWrap, removeBtn);
    li.addEventListener("click", () => selectPerson(person.id));
    els.peopleList.appendChild(li);
  });
}

/* ---------- Rendering: Pool tab ---------- */

function renderPoolTab() {
  const person = getSelectedPerson();
  if (!person) {
    els.noPersonSelected.classList.remove("hidden");
    els.personPool.classList.add("hidden");
    return;
  }
  els.noPersonSelected.classList.add("hidden");
  els.personPool.classList.remove("hidden");
  els.selectedPersonName.textContent = person.name;
  renderOpggBox(person);

  renderPersonPoolGrid(person);
  renderAllChampionsGrid();
}

function renderOpggBox(person) {
  els.opggBox.innerHTML = "";

  if (opggEditingId === person.id) {
    const form = document.createElement("form");
    form.className = "opgg-edit-form";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "na.op.gg link…";
    input.value = opggDraftValue;
    input.autocomplete = "off";
    input.addEventListener("input", () => {
      opggDraftValue = input.value;
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.textContent = "Save";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      opggEditingId = null;
      renderOpggBox(person);
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const newOpgg = normalizeUrl(opggDraftValue);
      opggEditingId = null;
      renderOpggBox(person);
      try {
        await updateDoc(personDoc(person.id), { opgg: newOpgg });
      } catch (err) {
        console.error(err);
        alert("Could not save that link — check your connection and try again.");
      }
    });

    form.append(input, saveBtn, cancelBtn);
    els.opggBox.appendChild(form);
    input.focus();
    return;
  }

  if (person.opgg) {
    const link = document.createElement("a");
    link.className = "opgg-link";
    link.href = person.opgg;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "OP.GG ↗";
    els.opggBox.appendChild(link);
  }

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "opgg-edit-btn";
  editBtn.textContent = person.opgg ? "edit" : "+ add OP.GG link";
  editBtn.addEventListener("click", () => {
    opggEditingId = person.id;
    opggDraftValue = person.opgg || "";
    renderOpggBox(person);
  });
  els.opggBox.appendChild(editBtn);
}

function renderRiotIdBox(person) {
  els.riotIdBox.innerHTML = "";

  if (riotIdEditingId === person.id) {
    const form = document.createElement("form");
    form.className = "opgg-edit-form";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Riot ID e.g. Name#Tag";
    input.value = riotIdDraftValue;
    input.autocomplete = "off";
    input.addEventListener("input", () => {
      riotIdDraftValue = input.value;
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.textContent = "Save";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      riotIdEditingId = null;
      renderRiotIdBox(person);
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const newRiotId = riotIdDraftValue.trim() || null;
      const changed = newRiotId !== (person.riotId || null);
      riotIdEditingId = null;
      renderRiotIdBox(person);
      try {
        // A changed Riot ID points at a different account, so the cached puuid (and any
        // locally-cached match data for the old account) would otherwise be stale.
        await updateDoc(personDoc(person.id), { riotId: newRiotId, puuid: changed ? null : person.puuid });
        if (changed) {
          delete matchesCache[person.id];
          delete statsCache[person.id];
          renderMatchesTab();
          renderStatsTab();
        }
      } catch (err) {
        console.error(err);
        alert("Could not save that Riot ID — check your connection and try again.");
      }
    });

    form.append(input, saveBtn, cancelBtn);
    els.riotIdBox.appendChild(form);
    input.focus();
    return;
  }

  if (person.riotId) {
    const label = document.createElement("span");
    label.className = "opgg-link";
    label.textContent = person.riotId;
    els.riotIdBox.appendChild(label);
  }

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "opgg-edit-btn";
  editBtn.textContent = person.riotId ? "edit" : "+ add Riot ID";
  editBtn.addEventListener("click", () => {
    riotIdEditingId = person.id;
    riotIdDraftValue = person.riotId || "";
    renderRiotIdBox(person);
  });
  els.riotIdBox.appendChild(editBtn);
}

function renderPersonPoolGrid(person) {
  els.poolGrid.innerHTML = "";
  person.pool.forEach((entry) => {
    const champ = championsById[entry.championId];
    if (!champ) return;
    const node = buildChampIcon(champ);
    node.classList.add("in-pool");

    const tierBadge = document.createElement("span");
    tierBadge.className = "tier-chip tier-badge";
    updateTierBadge(tierBadge, entry.tier);
    node.appendChild(tierBadge);

    const tierSelect = document.createElement("select");
    tierSelect.className = "tier-select";
    const noTierOpt = document.createElement("option");
    noTierOpt.value = "";
    noTierOpt.textContent = "Unranked";
    tierSelect.appendChild(noTierOpt);
    TIERS.forEach((tier) => {
      const opt = document.createElement("option");
      opt.value = tier;
      opt.textContent = `${tier} Tier`;
      if (entry.tier === tier) opt.selected = true;
      tierSelect.appendChild(opt);
    });
    tierSelect.addEventListener("click", (e) => e.stopPropagation());
    tierSelect.addEventListener("change", () => {
      const newTier = tierSelect.value || null;
      updateTierBadge(tierBadge, newTier);
      updatePoolEntry(person, entry.championId, { tier: newTier });
    });

    // A dropdown can only say one thing. Flex picks are the whole point of a pool, so the roles
    // are toggle chips instead — a champion can be marked Top and Mid at once.
    const roleChips = document.createElement("div");
    roleChips.className = "role-chips";
    roleChips.addEventListener("click", (e) => e.stopPropagation());
    ROLES.forEach((role) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "role-chip";
      chip.textContent = ROLE_SHORT[role] || role;
      chip.title = role;
      if (entryHasRole(entry, role)) chip.classList.add("active");
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleEntryRole(person, entry, role);
      });
      roleChips.appendChild(chip);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-champ";
    removeBtn.textContent = "×";
    removeBtn.title = `Remove ${champ.name}`;
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nextPool = person.pool.filter((p) => p.championId !== entry.championId);
      savePool(person, nextPool);
    });

    node.append(tierSelect, roleChips, removeBtn);
    els.poolGrid.appendChild(node);
  });
}

function renderAllChampionsGrid() {
  const person = getSelectedPerson();
  if (!person) return;

  const query = els.championSearch.value.trim().toLowerCase();
  const poolIds = new Set(person.pool.map((p) => p.championId));

  els.allChampionsGrid.innerHTML = "";
  championList
    .filter((c) => c.name.toLowerCase().includes(query))
    .filter((c) => laneFilters.size === 0 || (COMMON_ROLES[c.id] || []).some((r) => laneFilters.has(r)))
    .filter((c) => classFilters.size === 0 || c.tags.some((t) => classFilters.has(t)))
    .forEach((champ) => {
      const node = buildChampIcon(champ);
      if (poolIds.has(champ.id)) node.classList.add("in-pool");
      node.addEventListener("click", () => toggleChampionInPool(person, champ.id));
      els.allChampionsGrid.appendChild(node);
    });
}

function toggleChampionInPool(person, championId) {
  const idx = person.pool.findIndex((p) => p.championId === championId);
  const nextPool =
    idx >= 0
      ? person.pool.filter((p) => p.championId !== championId)
      : [...person.pool, { championId, roles: [], role: null, tier: null }];
  savePool(person, nextPool);
}

function updateTierBadge(badgeEl, tier) {
  if (tier) {
    badgeEl.textContent = tier;
    badgeEl.dataset.tier = tier;
    badgeEl.hidden = false;
  } else {
    badgeEl.textContent = "";
    delete badgeEl.dataset.tier;
    badgeEl.hidden = true;
  }
}

function buildChampIcon(champ) {
  const node = els.championIconTemplate.content.firstElementChild.cloneNode(true);
  const img = node.querySelector("img");
  img.src = champ.image;
  img.alt = champ.name;
  node.querySelector(".champ-name").textContent = champ.name;
  return node;
}

/* ---------- Rendering: Overview tab ---------- */

function renderOverviewTab() {
  els.coverageWarnings.innerHTML = "";
  els.coverageTable.innerHTML = "";
  renderFlexSection();

  if (state.people.length === 0) {
    els.coverageTable.innerHTML = `<p class="empty-state">Add players to see role coverage.</p>`;
    return;
  }

  const coreRoles = ["Top", "Jungle", "Mid", "ADC", "Support"];
  coreRoles.forEach((role) => {
    const hasCoverage = state.people.some((p) => p.pool.some((entry) => entryHasRole(entry, role)));
    if (!hasCoverage) {
      const chip = document.createElement("div");
      chip.className = "warning-chip";
      chip.textContent = `No one has a champion assigned to ${role}`;
      els.coverageWarnings.appendChild(chip);
    }
  });

  const grid = document.createElement("div");
  grid.className = "overview-grid";
  const tierRank = (t) => (t ? TIERS.indexOf(t) : TIERS.length);

  state.people.forEach((person) => {
    const card = document.createElement("div");
    card.className = "overview-card";

    const header = document.createElement("div");
    header.className = "overview-card-header";
    header.textContent = person.name;
    card.appendChild(header);

    const rolesWithChamps = ROLES.filter((role) => person.pool.some((entry) => entryHasRole(entry, role)));

    if (rolesWithChamps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "overview-card-empty";
      empty.textContent = "No champions assigned yet.";
      card.appendChild(empty);
    } else {
      rolesWithChamps.forEach((role) => {
        const roleRow = document.createElement("div");
        roleRow.className = "overview-role-row";

        const label = document.createElement("span");
        label.className = "overview-role-label";
        label.textContent = role;
        roleRow.appendChild(label);

        const wrap = document.createElement("div");
        wrap.className = "role-champs";

        // A flex pick appears under every role it's marked for, which is the point — the same
        // champion genuinely is part of the Top pool and the Mid pool.
        const champsForRole = person.pool.filter((entry) => entryHasRole(entry, role));
        [...champsForRole]
          .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))
          .forEach((entry) => {
            const champ = championsById[entry.championId];
            if (!champ) return;
            const iconWrap = document.createElement("div");
            iconWrap.className = "mini-champ-wrap";

            const img = document.createElement("img");
            img.className = "mini-champ";
            img.src = champ.image;
            img.alt = champ.name;
            img.title = entry.tier ? `${champ.name} (${entry.tier} Tier)` : champ.name;
            iconWrap.appendChild(img);

            if (entry.tier) {
              const badge = document.createElement("span");
              badge.className = "tier-chip mini-tier-badge";
              updateTierBadge(badge, entry.tier);
              iconWrap.appendChild(badge);
            }

            wrap.appendChild(iconWrap);
          });

        roleRow.appendChild(wrap);
        card.appendChild(roleRow);
      });
    }

    grid.appendChild(card);
  });

  els.coverageTable.appendChild(grid);
}

/* ---------- Rendering: Calendar tab ---------- */

/* ---------- Rendering: Draft flex ---------- */

// Three separate ways a pool hides information during a draft. They are different weapons:
// a two-role champion hides *what lane*, a movable player hides *who plays where*, and a
// shared champion hides *which of you* is on it. Each is computed from pools alone — no
// Riot requests, so this is free to keep up to date.
// Pools here run to 40-70 champions each, so every one of these lists is filtered to the
// picks someone would actually lock in — S and A tier. Unfiltered, all three become walls
// of every champion in the game and say nothing.
const FLEX_TIERS = ["S", "A"];
const FLEX_ROLE_MIN = 2; // champions in a role before it counts as a role they can play
const FLEX_SHARED_LIMIT = 12;

function flexAnalysis() {
  const withPools = state.people.filter((p) => (p.pool || []).length > 0);
  const topPicks = (person) => (person.pool || []).filter((e) => FLEX_TIERS.includes(e.tier));

  const twoRoleChampions = [];
  const sharedChampions = new Map();

  withPools.forEach((person) => {
    topPicks(person).forEach((entry) => {
      const champ = championsById[entry.championId];
      if (!champ) return;

      const lanes = COMMON_ROLES[entry.championId] || [];
      if (lanes.length > 1) {
        twoRoleChampions.push({ champ, lanes, person, tier: entry.tier, assignedRoles: entryRoles(entry) });
      }

      if (!sharedChampions.has(entry.championId)) sharedChampions.set(entry.championId, { champ, people: [] });
      sharedChampions.get(entry.championId).people.push({ person, tier: entry.tier, roles: entryRoles(entry) });
    });
  });

  // A role someone "can play" comes from what they marked, when they marked anything: now that
  // an entry can carry several roles, an explicit assignment is a stated intention and beats a
  // guess. Pools where nothing is marked still fall back to inferring the role from the
  // champion, otherwise this would say nobody can move.
  const movablePlayers = withPools
    .map((person) => {
      const picks = topPicks(person);
      const anyAssigned = picks.some((e) => entryRoles(e).length > 0);
      const rolesOf = (entry) => (anyAssigned ? entryRoles(entry) : COMMON_ROLES[entry.championId] || []);
      const roles = COMP_ROLES.map((role) => ({
        role,
        count: picks.filter((e) => rolesOf(e).includes(role)).length,
      })).filter((r) => r.count >= FLEX_ROLE_MIN);
      return { person, roles: roles.sort((a, b) => b.count - a.count) };
    })
    .filter((p) => p.roles.length > 1)
    .sort((a, b) => b.roles.length - a.roles.length);

  const shared = [...sharedChampions.values()]
    .filter((s) => s.people.length > 1)
    .sort((a, b) => b.people.length - a.people.length || a.champ.name.localeCompare(b.champ.name));

  return { twoRoleChampions: twoRoleChampions.sort((a, b) => a.tier.localeCompare(b.tier)), movablePlayers, shared };
}

function renderFlexSection() {
  els.flexSection.innerHTML = "";
  if (state.people.length === 0) return;

  const { twoRoleChampions, movablePlayers, shared } = flexAnalysis();

  els.flexSection.appendChild(
    buildFlexBlock(
      "Champions that hide the lane",
      "S and A picks playable in more than one role — locking one early does not tell them where it is going.",
      twoRoleChampions.slice(0, FLEX_SHARED_LIMIT).map((f) => ({
        champ: f.champ,
        label: `${f.tier} · ${f.lanes.join(" / ")} · ${f.person.name}`,
      })),
      "No two-role champion is rated S or A in anyone's pool yet.",
      twoRoleChampions.length > FLEX_SHARED_LIMIT
        ? `+ ${twoRoleChampions.length - FLEX_SHARED_LIMIT} more, S tier shown first`
        : null
    )
  );

  els.flexSection.appendChild(
    buildFlexBlock(
      "Players who can move",
      `Roles covered by at least ${FLEX_ROLE_MIN} of their S/A picks, so the lineup is not fixed before the draft.`,
      movablePlayers.map((m) => ({
        label: `${m.person.name} — ${m.roles.map((r) => `${r.role} (${r.count})`).join(", ")}`,
      })),
      "No one's top picks span two roles yet."
    )
  );

  els.flexSection.appendChild(
    buildFlexBlock(
      "Picks more than one of you can play",
      "Banning it costs them a ban against several of you; picking it hides which of you is on it.",
      shared.slice(0, FLEX_SHARED_LIMIT).map((s) => ({
        champ: s.champ,
        label: s.people.map((p) => `${p.person.name} (${p.tier})`).join(", "),
      })),
      "No champion is rated S or A by two of you yet.",
      shared.length > FLEX_SHARED_LIMIT ? `+ ${shared.length - FLEX_SHARED_LIMIT} more shared picks` : null
    )
  );
}

function buildFlexBlock(title, blurb, rows, emptyText, footnote) {
  const block = document.createElement("div");
  block.className = "flex-block";

  const heading = document.createElement("h3");
  heading.textContent = title;
  block.appendChild(heading);

  const note = document.createElement("p");
  note.className = "flex-blurb";
  note.textContent = blurb;
  block.appendChild(note);

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyText;
    block.appendChild(empty);
    return block;
  }

  rows.forEach((row) => {
    const line = document.createElement("div");
    line.className = "flex-row";

    if (row.champ) {
      const img = document.createElement("img");
      img.src = row.champ.image;
      img.alt = row.champ.name;
      line.appendChild(img);

      const name = document.createElement("span");
      name.className = "flex-champ-name";
      name.textContent = row.champ.name;
      line.appendChild(name);
    }

    const label = document.createElement("span");
    label.className = "flex-label";
    label.textContent = row.label;
    line.appendChild(label);

    block.appendChild(line);
  });

  if (footnote) {
    const more = document.createElement("p");
    more.className = "flex-blurb";
    more.style.marginTop = "8px";
    more.textContent = footnote;
    block.appendChild(more);
  }

  return block;
}

function formatDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTime(time24) {
  const [h, m] = time24.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function formatTimezoneAbbr(dateStr, tz) {
  try {
    const date = new Date(`${dateStr}T12:00:00`);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return tzPart ? tzPart.value : tz;
  } catch {
    return tz;
  }
}

// What wall-clock time a zone shows at a given instant, expressed as a UTC-interpreted
// timestamp so it can be subtracted from one. Intl parts rather than a toLocaleString
// round-trip, because new Date(string) parses in the machine's zone and would cancel the
// very offset being measured.
function wallClockAsUtcMs(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
}

// An event stores the wall time its author typed plus the author's zone; everyone else's
// browser shifts it onto their own clock here. Off-by-an-hour is possible in the minutes
// around a DST switch, an acceptable trade against shipping a timezone database for a
// scrim calendar.
function formatEventTimeLocal(ev) {
  const tz = ev.timezone || DEFAULT_TIMEZONE;
  try {
    const naive = Date.parse(`${ev.date}T${ev.time}:00Z`);
    if (isNaN(naive)) throw new Error("bad date");
    // The zone's offset at (roughly) that moment, measured by how far the zone's wall clock
    // sits from UTC; adding it back turns "18:30 on the author's wall" into a real instant.
    const instant = new Date(naive + (naive - wallClockAsUtcMs(new Date(naive), tz)));

    let label = instant.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    // Shifting zones can cross midnight — flag it, or "11:30 PM" on the wrong square reads as a typo.
    if (formatDateKey(instant) !== ev.date) {
      label += ` (${instant.toLocaleDateString(undefined, { month: "short", day: "numeric" })})`;
    }
    return label;
  } catch {
    return `${formatTime(ev.time)} ${formatTimezoneAbbr(ev.date, tz)}`;
  }
}

// Scrim teams die of attendance, not of draft. The calendar records who ticked the box for an
// event; nobody ever reads back who stopped ticking it. Only events already in the past count —
// an upcoming Saturday nobody has confirmed yet is not a no-show.
function attendanceHistory() {
  const todayKey = formatDateKey(new Date());
  const past = events
    .filter((ev) => ev.date && ev.date < todayKey)
    .sort((a, b) => a.date.localeCompare(b.date));

  const rows = state.people.map((person) => {
    const attended = past.filter((ev) => (ev.attendees || []).includes(person.id)).length;

    // Consecutive misses counting back from the most recent event. A season-long average hides
    // someone who came to everything in April and nothing since; this is the number that
    // actually predicts whether they'll turn up on Saturday.
    let missStreak = 0;
    for (let i = past.length - 1; i >= 0; i--) {
      if ((past[i].attendees || []).includes(person.id)) break;
      missStreak++;
    }

    return { person, attended, total: past.length, rate: past.length ? attended / past.length : 0, missStreak };
  });

  rows.sort((a, b) => a.rate - b.rate || a.person.name.localeCompare(b.person.name));
  return { past, rows };
}

function renderAttendanceSection() {
  els.attendanceSection.innerHTML = "";
  if (state.people.length === 0) return;

  const { past, rows } = attendanceHistory();

  const heading = document.createElement("h3");
  heading.textContent = "Attendance";
  els.attendanceSection.appendChild(heading);

  if (past.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No past events yet — attendance shows up once an event date has gone by.";
    els.attendanceSection.appendChild(empty);
    return;
  }

  const sub = document.createElement("p");
  sub.className = "attendance-sub";
  sub.textContent = `Across ${past.length} past event${past.length === 1 ? "" : "s"} · lowest turnout first`;
  els.attendanceSection.appendChild(sub);

  const list = document.createElement("div");
  list.className = "attendance-list";

  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "attendance-row";

    const name = document.createElement("div");
    name.className = "attendance-name";
    name.textContent = row.person.name;

    const bar = document.createElement("div");
    bar.className = "attendance-bar";
    const fill = document.createElement("div");
    fill.className = "attendance-bar-fill";
    fill.style.width = `${Math.round(row.rate * 100)}%`;
    if (row.rate < 0.5) fill.classList.add("low");
    bar.appendChild(fill);

    const count = document.createElement("div");
    count.className = "attendance-count";
    count.textContent = `${row.attended}/${row.total} (${Math.round(row.rate * 100)}%)`;

    item.append(name, bar, count);

    if (row.missStreak >= 2) {
      const streak = document.createElement("span");
      streak.className = "attendance-streak";
      streak.textContent = `missed last ${row.missStreak}`;
      item.appendChild(streak);
    }

    list.appendChild(item);
  });

  els.attendanceSection.appendChild(list);
}

function renderCalendarTab() {
  renderAttendanceSection();

  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  els.calendarMonthLabel.textContent = calendarViewDate.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const firstOfMonth = new Date(year, month, 1);
  const startDay = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const eventsByDate = {};
  events.forEach((ev) => {
    (eventsByDate[ev.date] ||= []).push(ev);
  });

  els.calendarGrid.innerHTML = "";

  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => {
    const el = document.createElement("div");
    el.className = "calendar-weekday";
    el.textContent = d;
    els.calendarGrid.appendChild(el);
  });

  for (let i = 0; i < startDay; i++) {
    const blank = document.createElement("div");
    blank.className = "calendar-day empty";
    els.calendarGrid.appendChild(blank);
  }

  const todayKey = formatDateKey(new Date());

  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = formatDateKey(new Date(year, month, day));
    const cell = document.createElement("div");
    cell.className = "calendar-day";
    if (dateKey === todayKey) cell.classList.add("today");
    if (dateKey === selectedCalendarDate) cell.classList.add("selected");

    const num = document.createElement("span");
    num.className = "calendar-day-number";
    num.textContent = day;
    cell.appendChild(num);

    const dayEvents = eventsByDate[dateKey] || [];
    dayEvents.slice(0, 3).forEach((ev) => {
      const chip = document.createElement("span");
      chip.className = "calendar-event-chip";
      chip.textContent = ev.title;
      cell.appendChild(chip);
    });
    if (dayEvents.length > 3) {
      const more = document.createElement("span");
      more.className = "calendar-event-more";
      more.textContent = `+${dayEvents.length - 3} more`;
      cell.appendChild(more);
    }

    cell.addEventListener("click", () => {
      selectedCalendarDate = dateKey;
      els.newEventDate.value = dateKey;
      renderCalendarTab();
    });

    els.calendarGrid.appendChild(cell);
  }

  renderDayDetailPanel();
}

function renderDayDetailPanel() {
  if (!selectedCalendarDate) {
    els.dayDetailPanel.classList.add("hidden");
    return;
  }
  els.dayDetailPanel.classList.remove("hidden");

  const dayEvents = events.filter((ev) => ev.date === selectedCalendarDate);
  const dateObj = new Date(`${selectedCalendarDate}T00:00:00`);
  els.dayDetailTitle.textContent = dateObj.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  els.dayDetailEvents.innerHTML = "";

  if (dayEvents.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No events yet — add one above.";
    els.dayDetailEvents.appendChild(p);
    return;
  }

  [...dayEvents]
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""))
    .forEach((ev) => {
      const node = editingEventId === ev.id ? buildEventEditForm(ev) : buildEventDisplayCard(ev);
      els.dayDetailEvents.appendChild(node);
    });
}

function buildEventDisplayCard(ev) {
  const card = document.createElement("div");
  card.className = "event-card";

  const header = document.createElement("div");
  header.className = "event-card-header";
  const titleEl = document.createElement("strong");
  titleEl.textContent = ev.time ? `${formatEventTimeLocal(ev)} — ${ev.title}` : ev.title;

  const actions = document.createElement("div");
  actions.className = "event-card-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "edit-event";
  editBtn.textContent = "edit";
  editBtn.addEventListener("click", () => {
    editingEventId = ev.id;
    eventDraft = {
      title: ev.title,
      date: ev.date,
      time: ev.time || "",
      timezone: ev.timezone || DEFAULT_TIMEZONE,
      notes: ev.notes || "",
    };
    renderDayDetailPanel();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "remove-event";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete event";
  deleteBtn.addEventListener("click", () => {
    if (confirm(`Delete "${ev.title}"?`)) deleteEvent(ev.id);
  });

  actions.append(editBtn, deleteBtn);
  header.append(titleEl, actions);
  card.appendChild(header);

  if (ev.notes) {
    const notesEl = document.createElement("p");
    notesEl.className = "event-notes";
    notesEl.textContent = ev.notes;
    card.appendChild(notesEl);
  }

  const attendeeWrap = document.createElement("div");
  attendeeWrap.className = "attendee-list";
  if (state.people.length === 0) {
    const p = document.createElement("p");
    p.className = "no-champs";
    p.textContent = "Add players first to mark attendance.";
    attendeeWrap.appendChild(p);
  } else {
    state.people.forEach((person) => {
      const label = document.createElement("label");
      label.className = "attendee-chip";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = (ev.attendees || []).includes(person.id);
      checkbox.addEventListener("change", () => toggleAttendee(ev, person.id));
      label.append(checkbox, document.createTextNode(person.name));
      attendeeWrap.appendChild(label);
    });
  }
  card.appendChild(attendeeWrap);

  return card;
}

function buildEventEditForm(ev) {
  const card = document.createElement("div");
  card.className = "event-card";

  const form = document.createElement("form");
  form.className = "event-edit-form";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.required = true;
  titleInput.value = eventDraft.title;
  titleInput.addEventListener("input", () => (eventDraft.title = titleInput.value));

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.required = true;
  dateInput.value = eventDraft.date;
  dateInput.addEventListener("input", () => (eventDraft.date = dateInput.value));

  const timeInput = document.createElement("input");
  timeInput.type = "time";
  timeInput.value = eventDraft.time;
  timeInput.addEventListener("input", () => (eventDraft.time = timeInput.value));

  const notesInput = document.createElement("input");
  notesInput.type = "text";
  notesInput.placeholder = "Notes (optional)";
  notesInput.value = eventDraft.notes;
  notesInput.addEventListener("input", () => (eventDraft.notes = notesInput.value));

  const actions = document.createElement("div");
  actions.className = "event-edit-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Save";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    editingEventId = null;
    eventDraft = null;
    renderDayDetailPanel();
  });

  actions.append(saveBtn, cancelBtn);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = eventDraft.title.trim();
    const date = eventDraft.date;
    if (!title || !date) return;
    const changes = {
      title,
      date,
      time: eventDraft.time || null,
      // Retyping the time means the editor meant it in their own zone; leaving it alone keeps
      // the original author's zone, so a title fix in another timezone can't shift the event.
      timezone: eventDraft.time !== (ev.time || "") ? DEFAULT_TIMEZONE : eventDraft.timezone || DEFAULT_TIMEZONE,
      notes: eventDraft.notes.trim() || null,
    };
    selectedCalendarDate = date;
    editingEventId = null;
    eventDraft = null;
    renderDayDetailPanel();
    updateEvent(ev.id, changes);
  });

  form.append(titleInput, dateInput, timeInput, notesInput, actions);
  card.appendChild(form);
  return card;
}

/* ---------- Rendering: Comps tab ---------- */

function renderCompsTab() {
  els.compsList.innerHTML = "";

  if (teamComps.length === 0) {
    els.compsList.innerHTML = `<p class="empty-state">No team comps yet — add one above.</p>`;
    return;
  }

  teamComps.forEach((comp) => {
    els.compsList.appendChild(buildCompCard(comp));
  });
}

function buildCompCard(comp) {
  const card = document.createElement("div");
  card.className = "comp-card";

  const header = document.createElement("div");
  header.className = "comp-card-header";

  const title = document.createElement("h3");
  title.textContent = comp.name;

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "remove-comp";
  deleteBtn.textContent = "×";
  deleteBtn.title = `Delete ${comp.name}`;
  deleteBtn.addEventListener("click", () => {
    if (confirm(`Delete team comp "${comp.name}"?`)) deleteTeamComp(comp.id);
  });

  header.append(title, deleteBtn);
  card.appendChild(header);

  COMP_ROLES.forEach((role) => {
    card.appendChild(buildCompRoleRow(comp, role));
  });

  return card;
}

function buildCompRoleRow(comp, role) {
  const row = document.createElement("div");
  row.className = "comp-role-row";

  const labelWrap = document.createElement("div");
  labelWrap.className = "comp-role-label-wrap";
  const label = document.createElement("span");
  label.className = "comp-role-label";
  label.textContent = role;
  labelWrap.appendChild(label);

  const champsWrap = document.createElement("div");
  champsWrap.className = "comp-role-champs";

  const championIds = comp.roles?.[role] || [];
  championIds.forEach((champId) => {
    const champ = championsById[champId];
    if (!champ) return;

    const chip = document.createElement("div");
    chip.className = "comp-champ-chip";

    const img = document.createElement("img");
    img.src = champ.image;
    img.alt = champ.name;
    img.title = champ.name;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-comp-champ";
    removeBtn.textContent = "×";
    removeBtn.title = `Remove ${champ.name}`;
    removeBtn.addEventListener("click", () => toggleCompChampion(comp, role, champId));

    chip.append(img, removeBtn);
    champsWrap.appendChild(chip);
  });

  const pickerKey = `${comp.id}:${role}`;
  const isPickerOpen = activeCompPickerKey === pickerKey;

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "add-comp-champ-btn";
  addBtn.textContent = isPickerOpen ? "close" : "+ add";
  addBtn.addEventListener("click", () => {
    activeCompPickerKey = isPickerOpen ? null : pickerKey;
    compPickerSearch = "";
    renderCompsTab();
  });

  row.append(labelWrap, champsWrap, addBtn);

  if (isPickerOpen) {
    row.appendChild(buildCompChampionPicker(comp, role));
  }

  return row;
}

function buildCompChampionPicker(comp, role) {
  const wrap = document.createElement("div");
  wrap.className = "comp-champ-picker";

  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "Search champions…";
  search.autocomplete = "off";
  search.value = compPickerSearch;

  const grid = document.createElement("div");
  grid.className = "champion-grid comp-picker-grid";

  function renderGrid() {
    const selectedIds = new Set(comp.roles?.[role] || []);
    const query = compPickerSearch.trim().toLowerCase();
    grid.innerHTML = "";
    championList
      .filter((c) => c.name.toLowerCase().includes(query))
      .forEach((champ) => {
        const node = buildChampIcon(champ);
        if (selectedIds.has(champ.id)) node.classList.add("in-pool");
        node.addEventListener("click", () => toggleCompChampion(comp, role, champ.id));
        grid.appendChild(node);
      });
  }

  search.addEventListener("input", () => {
    compPickerSearch = search.value;
    renderGrid();
  });

  renderGrid();
  wrap.append(search, grid);
  return wrap;
}

/* ---------- Match data (Riot API via Cloudflare proxy) ---------- */

async function loadMatchData(person) {
  if (!person.riotId) return;

  matchesLoadingId = person.id;
  renderMatchesTab();

  try {
    let puuid = person.puuid || null;

    if (!puuid) {
      const [gameName, tagLine] = splitRiotId(person.riotId);
      if (!gameName || !tagLine) throw new Error("Riot ID should look like Name#Tag");

      const account = await riotFetch(
        `/account?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine)}`
      );
      if (!account.ok) {
        throw new Error(riotErrorMessage(account.data, "Could not find that Riot ID"));
      }
      puuid = account.data.puuid;
      // Cache the resolved puuid on the shared player doc so future loads (by anyone) skip this lookup.
      await updateDoc(personDoc(person.id), { puuid });
    }

    // 20 rather than 5: the proxy can't filter by queue, so the solo/flex split happens here,
    // and a 5-game window regularly contains none of the queue being asked about.
    const [rankedRes, liveRes, matchIdsRes] = await Promise.all([
      riotFetch(`/ranked?puuid=${puuid}`),
      riotFetch(`/live?puuid=${puuid}`),
      riotFetch(`/matches?puuid=${puuid}&count=${STATS_MATCH_COUNT}`),
    ]);
    const ranked = rankedRes.data;
    const live = liveRes.data;
    const matchIds = matchIdsRes.data;

    if (!rankedRes.ok) throw new Error(riotErrorMessage(ranked, "Could not load ranked stats"));
    if (!liveRes.ok) throw new Error(riotErrorMessage(live, "Could not load live game status"));
    if (!matchIdsRes.ok) throw new Error(riotErrorMessage(matchIds, "Could not load match history"));

    const matches = await Promise.all(
      (Array.isArray(matchIds) ? matchIds : []).map((id) => riotFetch(`/match/${id}`).then((r) => r.data))
    );

    matchesCache[person.id] = { ranked, live, matches, puuid };
    // The Stats tab aggregates these exact same games — hand them over so it costs nothing.
    statsCache[person.id] = splitStatsByQueue(matches, puuid);
  } catch (err) {
    console.error(err);
    matchesCache[person.id] = { loadError: err.message || "Something went wrong loading match data." };
  } finally {
    matchesLoadingId = null;
    renderMatchesTab();
    renderStatsTab();
  }
}

function queueFilterLabel() {
  return rankedQueueFilter === 420 ? "Solo Queue" : "Flex Queue";
}

function syncQueueToggles() {
  [els.matchesQueueToggle, els.statsQueueToggle].forEach((toggle) => {
    toggle.querySelectorAll("button[data-queue]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.queue) === rankedQueueFilter);
    });
  });
}

function renderMatchesTab() {
  const person = getSelectedPerson();
  if (!person) {
    els.noPersonSelectedMatches.classList.remove("hidden");
    els.matchesContent.classList.add("hidden");
    return;
  }
  els.noPersonSelectedMatches.classList.add("hidden");
  els.matchesContent.classList.remove("hidden");
  els.matchesPersonName.textContent = person.name;
  renderRiotIdBox(person);

  const isLoading = matchesLoadingId === person.id;
  els.loadMatchesBtn.disabled = isLoading || !person.riotId;
  els.loadMatchesBtn.textContent = isLoading ? "Loading…" : "Load match data";

  const cached = matchesCache[person.id];

  els.matchesStatus.classList.remove("error");
  if (!person.riotId) {
    els.matchesStatus.textContent = "Add a Riot ID above to pull match data.";
  } else if (isLoading) {
    els.matchesStatus.textContent = "Fetching from Riot…";
  } else if (cached && cached.loadError) {
    els.matchesStatus.textContent = cached.loadError;
    els.matchesStatus.classList.add("error");
  } else {
    els.matchesStatus.textContent = "";
  }

  renderRankedSection(cached);
  renderLiveSection(cached);
  renderHistorySection(cached);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatRelativeTime(timestampMs) {
  const diffMs = Date.now() - timestampMs;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderRankedSection(cached) {
  els.rankedSection.innerHTML = "";
  if (!cached || cached.loadError || !cached.ranked) return;

  const heading = document.createElement("h3");
  heading.textContent = "Ranked";
  els.rankedSection.appendChild(heading);

  if (cached.ranked.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "Unranked.";
    els.rankedSection.appendChild(p);
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "ranked-cards";

  cached.ranked.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "ranked-card";

    const queue = document.createElement("div");
    queue.className = "ranked-queue";
    queue.textContent =
      entry.queueType === "RANKED_SOLO_5x5" ? "Solo/Duo" : entry.queueType === "RANKED_FLEX_SR" ? "Flex" : entry.queueType;

    const tier = document.createElement("div");
    tier.className = "ranked-tier";
    tier.textContent = `${titleCase(entry.tier)} ${entry.rank} — ${entry.leaguePoints} LP`;

    const record = document.createElement("div");
    record.className = "ranked-record";
    const total = entry.wins + entry.losses;
    const winRate = total > 0 ? Math.round((entry.wins / total) * 100) : 0;
    record.textContent = `${entry.wins}W ${entry.losses}L (${winRate}%)`;

    card.append(queue, tier, record);
    wrap.appendChild(card);
  });

  els.rankedSection.appendChild(wrap);
}

function renderLiveSection(cached) {
  els.liveSection.innerHTML = "";
  if (!cached || cached.loadError || !cached.live) return;

  const heading = document.createElement("h3");
  heading.textContent = "Live Game";
  els.liveSection.appendChild(heading);

  const card = document.createElement("div");
  card.className = "live-card" + (cached.live.inGame ? " in-game" : "");

  const status = document.createElement("div");
  status.className = "live-status";
  status.textContent = cached.live.inGame ? "Currently in a game" : "Not in a game";
  card.appendChild(status);

  if (cached.live.inGame && Array.isArray(cached.live.participants)) {
    const champsWrap = document.createElement("div");
    champsWrap.className = "live-champs";
    cached.live.participants.forEach((p) => {
      const champ = findChampionByKey(p.championId);
      if (!champ) return;
      const img = document.createElement("img");
      img.src = champ.image;
      img.alt = champ.name;
      img.title = champ.name;
      champsWrap.appendChild(img);
    });
    card.appendChild(champsWrap);
  }

  els.liveSection.appendChild(card);
}

function renderHistorySection(cached) {
  els.historySection.innerHTML = "";
  if (!cached || cached.loadError || !cached.matches) return;

  const heading = document.createElement("h3");
  heading.textContent = `Recent ${queueFilterLabel()} Matches`;
  els.historySection.appendChild(heading);

  const filtered = cached.matches.filter((m) => m?.info?.queueId === rankedQueueFilter);

  if (filtered.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = `No ${queueFilterLabel()} games in their last ${cached.matches.length} matches.`;
    els.historySection.appendChild(p);
    return;
  }

  filtered.forEach((match) => {
    if (!match || !match.info) return;
    const me = match.info.participants.find((p) => p.puuid === cached.puuid);
    if (!me) return;

    const card = document.createElement("div");
    card.className = "match-card " + (me.win ? "win" : "loss");

    const champ = findChampionByName(me.championName);
    const img = document.createElement("img");
    img.src = champ ? champ.image : "";
    img.alt = me.championName;

    const infoWrap = document.createElement("div");
    infoWrap.className = "match-card-info";
    const champName = document.createElement("div");
    champName.className = "match-card-champ";
    champName.textContent = champ ? champ.name : me.championName;
    const meta = document.createElement("div");
    meta.className = "match-card-meta";
    const queueName = QUEUE_NAMES[match.info.queueId] || `Queue ${match.info.queueId}`;
    meta.textContent = `${queueName} · ${formatDuration(match.info.gameDuration)} · ${formatRelativeTime(match.info.gameEndTimestamp || match.info.gameCreation)}`;
    infoWrap.append(champName, meta);

    const resultWrap = document.createElement("div");
    resultWrap.className = "match-card-result";
    const resultText = document.createElement("div");
    resultText.className = "result-text";
    resultText.textContent = me.win ? "Victory" : "Defeat";
    const kdaText = document.createElement("div");
    kdaText.className = "kda-text";
    kdaText.textContent = `${me.kills}/${me.deaths}/${me.assists}`;
    resultWrap.append(resultText, kdaText);

    card.append(img, infoWrap, resultWrap);
    els.historySection.appendChild(card);
  });
}

/* ---------- Stats (aggregated from Riot match history) ---------- */

// The proxy can't ask Riot for one queue, so both aggregates come out of a single fetch and
// the toggle just picks which one to show — flipping it is free.
function splitStatsByQueue(matches, puuid) {
  return {
    fetched: matches.filter((m) => m?.info).length,
    solo: aggregateStats(matches.filter((m) => m?.info?.queueId === 420), puuid),
    flex: aggregateStats(matches.filter((m) => m?.info?.queueId === 440), puuid),
  };
}

// The queue-selected slice of a person's stats cache, with errors passed straight through.
function selectedStats(cached) {
  if (!cached || cached.loadError) return cached;
  return rankedQueueFilter === 420 ? cached.solo : cached.flex;
}

async function loadStatsData(person) {
  if (!person.riotId) return;

  // The Matches tab fetches the same 20 games — if they're already here, this is free.
  const shared = matchesCache[person.id];
  if (shared && !shared.loadError && Array.isArray(shared.matches) && shared.puuid) {
    statsCache[person.id] = splitStatsByQueue(shared.matches, shared.puuid);
    renderStatsTab();
    return;
  }

  statsLoadingId = person.id;
  renderStatsTab();

  try {
    let puuid = person.puuid || null;

    if (!puuid) {
      const [gameName, tagLine] = splitRiotId(person.riotId);
      if (!gameName || !tagLine) throw new Error("Riot ID should look like Name#Tag");

      const account = await riotFetch(
        `/account?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine)}`
      );
      if (!account.ok) throw new Error(riotErrorMessage(account.data, "Could not find that Riot ID"));
      puuid = account.data.puuid;
      await updateDoc(personDoc(person.id), { puuid });
    }

    const matchIdsRes = await riotFetch(`/matches?puuid=${puuid}&count=${STATS_MATCH_COUNT}`);
    const matchIds = matchIdsRes.data;
    if (!matchIdsRes.ok) throw new Error(riotErrorMessage(matchIds, "Could not load match history"));

    const matches = await Promise.all(
      (Array.isArray(matchIds) ? matchIds : []).map((id) => riotFetch(`/match/${id}`).then((r) => r.data))
    );

    statsCache[person.id] = splitStatsByQueue(matches, puuid);
  } catch (err) {
    console.error(err);
    statsCache[person.id] = { loadError: err.message || "Something went wrong loading stats." };
  } finally {
    statsLoadingId = null;
    renderStatsTab();
  }
}

function renderStatsTab() {
  const person = getSelectedPerson();
  if (!person) {
    els.noPersonSelectedStats.classList.remove("hidden");
    els.statsContent.classList.add("hidden");
    return;
  }
  els.noPersonSelectedStats.classList.add("hidden");
  els.statsContent.classList.remove("hidden");
  els.statsPersonName.textContent = person.name;

  const isLoading = statsLoadingId === person.id;
  els.refreshStatsBtn.disabled = isLoading || !person.riotId;
  els.refreshStatsBtn.textContent = isLoading ? "Loading…" : "Refresh Stats";

  const cached = statsCache[person.id];

  els.statsStatus.classList.remove("error");
  if (!person.riotId) {
    els.statsStatus.textContent = "Add a Riot ID on the Matches tab to pull stats.";
  } else if (isLoading) {
    els.statsStatus.textContent = `Analyzing last ${STATS_MATCH_COUNT} matches…`;
  } else if (cached && cached.loadError) {
    els.statsStatus.textContent = cached.loadError;
    els.statsStatus.classList.add("error");
  } else {
    els.statsStatus.textContent = "";
  }

  const selected = selectedStats(cached);
  renderStatsSummary(selected, cached);
  renderStatsRoles(selected);
  renderStatsChampions(selected);
}

function buildStatCard(label, value, sub, valueClass) {
  const card = document.createElement("div");
  card.className = "stats-summary-card";

  const labelEl = document.createElement("div");
  labelEl.className = "stat-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = "stat-value" + (valueClass ? ` ${valueClass}` : "");
  valueEl.textContent = value;

  const subEl = document.createElement("div");
  subEl.className = "stat-subvalue";
  subEl.textContent = sub;

  card.append(labelEl, valueEl, subEl);
  return card;
}

function renderStatsSummary(cached, full) {
  els.statsSummarySection.innerHTML = "";
  if (!cached || cached.loadError) return;
  if (cached.games === 0) {
    const fetched = full?.fetched ?? 0;
    els.statsSummarySection.innerHTML = `<p class="empty-state">No ${queueFilterLabel()} games in their last ${fetched} matches.</p>`;
    return;
  }

  const heading = document.createElement("h3");
  heading.textContent = "Summary";
  els.statsSummarySection.appendChild(heading);

  const wrap = document.createElement("div");
  wrap.className = "stats-summary-cards";

  const winRate = Math.round((cached.wins / cached.games) * 100);
  const recordCard = buildStatCard(
    "Record",
    `${cached.wins}W ${cached.losses}L`,
    `${winRate}% win rate`,
    winRate >= 50 ? "win-rate-good" : "win-rate-bad"
  );

  const avgK = (cached.kills / cached.games).toFixed(1);
  const avgD = (cached.deaths / cached.games).toFixed(1);
  const avgA = (cached.assists / cached.games).toFixed(1);
  const kda = cached.deaths > 0 ? ((cached.kills + cached.assists) / cached.deaths).toFixed(2) : "Perfect";
  const kdaCard = buildStatCard("Avg KDA", `${avgK} / ${avgD} / ${avgA}`, `${kda} KDA ratio`);

  const gamesCard = buildStatCard(
    "Games Analyzed",
    String(cached.games),
    `${queueFilterLabel()}, of their last ${full?.fetched ?? cached.games} games`
  );

  wrap.append(recordCard, kdaCard, gamesCard);
  els.statsSummarySection.appendChild(wrap);
}

function renderStatsRoles(cached) {
  els.statsRolesSection.innerHTML = "";
  if (!cached || cached.loadError || !cached.games) return;

  const heading = document.createElement("h3");
  heading.textContent = "Roles Played";
  els.statsRolesSection.appendChild(heading);

  const wrap = document.createElement("div");
  wrap.className = "role-breakdown";

  Object.entries(cached.roles)
    .sort((a, b) => b[1] - a[1])
    .forEach(([role, count]) => {
      const pill = document.createElement("span");
      pill.className = "role-pill";
      const strong = document.createElement("strong");
      strong.textContent = String(count);
      pill.append(strong, document.createTextNode(" " + (ROLE_DISPLAY_NAMES[role] || role)));
      wrap.appendChild(pill);
    });

  els.statsRolesSection.appendChild(wrap);
}

function renderStatsChampions(cached) {
  els.statsChampionsSection.innerHTML = "";
  if (!cached || cached.loadError || !cached.games) return;

  const heading = document.createElement("h3");
  heading.textContent = "Champion Breakdown";
  els.statsChampionsSection.appendChild(heading);

  const list = document.createElement("div");
  list.className = "champ-stat-list";

  Object.entries(cached.champions)
    .sort((a, b) => b[1].games - a[1].games)
    .forEach(([championName, stat]) => {
      const row = document.createElement("div");
      row.className = "champ-stat-row";

      const champ = findChampionByName(championName);
      const img = document.createElement("img");
      img.src = champ ? champ.image : "";
      img.alt = championName;

      const name = document.createElement("div");
      name.className = "champ-stat-name";
      name.textContent = champ ? champ.name : championName;

      const gamesEl = document.createElement("div");
      gamesEl.className = "champ-stat-games";
      gamesEl.textContent = `${stat.games} game${stat.games === 1 ? "" : "s"}`;

      const winRate = Math.round((stat.wins / stat.games) * 100);
      const winRateEl = document.createElement("div");
      winRateEl.className = "champ-stat-winrate " + (winRate >= 50 ? "good" : "bad");
      winRateEl.textContent = `${winRate}%`;

      const avgK = (stat.kills / stat.games).toFixed(1);
      const avgD = (stat.deaths / stat.games).toFixed(1);
      const avgA = (stat.assists / stat.games).toFixed(1);
      const kdaEl = document.createElement("div");
      kdaEl.className = "champ-stat-kda";
      kdaEl.textContent = `${avgK}/${avgD}/${avgA}`;

      row.append(img, name, gamesEl, winRateEl, kdaEl);
      list.appendChild(row);
    });

  els.statsChampionsSection.appendChild(list);
}

/* ---------- Custom games (logged by the local companion script) ---------- */

function renderCustomsTab() {
  // Notes are shared live, so someone else's review arriving mid-sentence would otherwise
  // rebuild the list and wipe what you're typing. Adding your own note blurs the box first,
  // so this only skips the redraws that would be destructive.
  if (document.activeElement?.classList?.contains("game-review-input")) return;

  renderCustomsSummary();

  els.customGamesList.innerHTML = "";
  if (customGames.length === 0) {
    els.customGamesList.innerHTML = `<p class="empty-state">No custom games logged yet.</p>`;
    return;
  }
  customGames.forEach((game) => {
    els.customGamesList.appendChild(buildCustomGameCard(game));
  });
}

// Which side "we" were on in a logged custom — whichever side holds the most roster players.
// In a 5v5 scrim that is unambiguous; a mixed or unrecognised lobby returns null rather than
// guessing, and every caller skips those games instead of counting them wrong.
function ourSideOf(game) {
  const ours = (game.participants || []).filter((p) => p.matchedPersonId);
  if (ours.length === 0) return null;

  const blueCount = ours.filter((p) => p.teamId === 100).length;
  const redCount = ours.length - blueCount;
  if (blueCount === redCount) return null;

  return blueCount > redCount ? "blue" : "red";
}

function teamIdForSide(side) {
  return side === "blue" ? 100 : 200;
}

// Which side we win on, read from the games we actually logged.
function customsSideRecord() {
  const record = { blue: { games: 0, wins: 0 }, red: { games: 0, wins: 0 }, skipped: 0 };

  customGames.forEach((game) => {
    const side = ourSideOf(game);
    if (!side) {
      record.skipped++;
      return;
    }

    const teamId = teamIdForSide(side);
    const won = (game.participants || []).some((p) => p.teamId === teamId && p.win);
    record[side].games++;
    if (won) record[side].wins++;
  });

  return record;
}

// Objective control. Winning is the outcome; taking objectives is the behaviour that produces
// it, and it's the half a team can actually practise. Only games logged after the logger
// started recording `teams` carry this, so it counts its own sample separately from the side
// record rather than silently averaging over games that never had the data.
const OBJECTIVE_FIRSTS = [
  { key: "firstBlood", label: "First blood" },
  { key: "firstTower", label: "First tower" },
  { key: "firstDragon", label: "First dragon" },
  { key: "firstRiftHerald", label: "First herald" },
  { key: "firstBaron", label: "First baron" },
];

const OBJECTIVE_COUNTS = [
  { key: "towerKills", label: "Towers" },
  { key: "dragonKills", label: "Dragons" },
  { key: "baronKills", label: "Barons" },
];

function customsObjectiveRecord() {
  const firsts = {};
  OBJECTIVE_FIRSTS.forEach((o) => (firsts[o.key] = 0));
  const counts = {};
  OBJECTIVE_COUNTS.forEach((o) => (counts[o.key] = { ours: 0, theirs: 0 }));
  let games = 0;

  customGames.forEach((game) => {
    const side = ourSideOf(game);
    if (!side || !Array.isArray(game.teams) || game.teams.length === 0) return;

    const ourTeamId = teamIdForSide(side);
    const ourTeam = game.teams.find((t) => t.teamId === ourTeamId);
    const theirTeam = game.teams.find((t) => t.teamId !== ourTeamId);
    if (!ourTeam) return;

    games++;
    OBJECTIVE_FIRSTS.forEach((o) => {
      if (ourTeam[o.key]) firsts[o.key]++;
    });
    OBJECTIVE_COUNTS.forEach((o) => {
      counts[o.key].ours += ourTeam[o.key] || 0;
      counts[o.key].theirs += theirTeam?.[o.key] || 0;
    });
  });

  return { games, firsts, counts };
}

function renderCustomsSummary() {
  els.customsSummary.innerHTML = "";
  if (customGames.length === 0) return;

  const record = customsSideRecord();
  const total = record.blue.games + record.red.games;
  if (total === 0) return;

  const wins = record.blue.wins + record.red.wins;
  const rate = (r) => (r.games ? Math.round((r.wins / r.games) * 100) : 0);

  const line = document.createElement("div");
  line.className = "draft-record-line";
  line.textContent =
    `${wins}W-${total - wins}L across ${total} logged custom${total === 1 ? "" : "s"} · ` +
    `blue ${record.blue.wins}/${record.blue.games} (${rate(record.blue)}%) · ` +
    `red ${record.red.wins}/${record.red.games} (${rate(record.red)}%)` +
    (record.skipped ? ` · ${record.skipped} skipped (no roster player, or players on both sides)` : "");
  els.customsSummary.appendChild(line);

  renderCustomsObjectives();
}

function renderCustomsObjectives() {
  const record = customsObjectiveRecord();
  if (record.games === 0) {
    // Every logged game predates objective capture. Say so plainly, so an empty section reads
    // as "not recorded yet" rather than "your team never takes an objective".
    const hint = document.createElement("div");
    hint.className = "customs-objectives-empty";
    hint.textContent =
      "Objective control isn't recorded for these games — re-run custom-game-logger.ps1 and it'll appear for games logged from now on.";
    els.customsSummary.appendChild(hint);
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "customs-objectives";

  const heading = document.createElement("div");
  heading.className = "customs-objectives-heading";
  heading.textContent = `Objective control · ${record.games} game${record.games === 1 ? "" : "s"}`;
  wrap.appendChild(heading);

  const grid = document.createElement("div");
  grid.className = "customs-objective-grid";

  OBJECTIVE_FIRSTS.forEach((o) => {
    const pct = Math.round((record.firsts[o.key] / record.games) * 100);
    grid.appendChild(buildObjectiveStat(o.label, `${pct}%`, `${record.firsts[o.key]}/${record.games}`));
  });

  OBJECTIVE_COUNTS.forEach((o) => {
    const { ours, theirs } = record.counts[o.key];
    const per = (n) => (n / record.games).toFixed(1);
    grid.appendChild(buildObjectiveStat(o.label, `${per(ours)} vs ${per(theirs)}`, "per game, us vs them"));
  });

  wrap.appendChild(grid);
  els.customsSummary.appendChild(wrap);
}

function buildObjectiveStat(label, value, sub) {
  const cell = document.createElement("div");
  cell.className = "customs-objective-stat";

  const labelEl = document.createElement("div");
  labelEl.className = "customs-objective-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = "customs-objective-value";
  valueEl.textContent = value;

  const subEl = document.createElement("div");
  subEl.className = "customs-objective-sub";
  subEl.textContent = sub;

  cell.append(labelEl, valueEl, subEl);
  return cell;
}

function buildCustomGameCard(game) {
  const card = document.createElement("div");
  card.className = "custom-game-card";

  const header = document.createElement("div");
  header.className = "custom-game-header";
  const dateStr = game.capturedAt?.toDate
    ? game.capturedAt.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "";
  const durationStr = game.gameDurationSeconds ? formatDuration(game.gameDurationSeconds) : "";
  header.textContent = [dateStr, durationStr].filter(Boolean).join(" · ");
  card.appendChild(header);

  const participants = game.participants || [];
  const blueSide = participants.filter((p) => p.teamId === 100);
  const redSide = participants.filter((p) => p.teamId === 200);

  const teamsWrap = document.createElement("div");
  teamsWrap.className = "custom-game-teams";
  teamsWrap.append(
    buildCustomGameTeam("Blue Side", blueSide, game, 100),
    buildCustomGameTeam("Red Side", redSide, game, 200)
  );
  card.appendChild(teamsWrap);

  card.appendChild(buildGameReviewSection(game));

  return card;
}

// VOD review wants "14:20 dragon" attached to the game it happened in. The Notes tab is
// free-floating text about a player; this is text about one game, so it hangs off the card.
function buildGameReviewSection(game) {
  const wrap = document.createElement("div");
  wrap.className = "game-review";

  const mine = gameReviews.filter((r) => r.gameId === game.id);

  const heading = document.createElement("div");
  heading.className = "game-review-heading";
  heading.textContent = mine.length ? `Review notes (${mine.length})` : "Review notes";
  wrap.appendChild(heading);

  const list = document.createElement("div");
  list.className = "game-review-list";
  mine.forEach((review) => list.appendChild(buildGameReviewCard(review)));
  wrap.appendChild(list);

  const form = document.createElement("form");
  form.className = "add-note-form game-review-form";

  const input = document.createElement("textarea");
  input.className = "game-review-input";
  input.placeholder = "What happened, and what should we do differently? e.g. \"14:20 dragon — no vision, forced anyway\"";
  input.required = true;

  const row = document.createElement("div");
  row.className = "add-note-form-row";
  const author = document.createElement("input");
  author.type = "text";
  author.placeholder = "Your name (optional)";
  author.autocomplete = "off";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Add Review";
  row.append(author, submit);

  form.append(input, row);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // Clear and blur before awaiting, so the snapshot that follows is free to redraw.
    input.value = "";
    input.blur();
    await addGameReview(game.id, author.value.trim(), text);
  });

  wrap.appendChild(form);
  return wrap;
}

function buildGameReviewCard(review) {
  const card = document.createElement("div");
  card.className = "note-card";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "remove-note";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete review note";
  deleteBtn.addEventListener("click", () => {
    if (confirm("Delete this review note?")) deleteNote(review.id);
  });

  const header = document.createElement("div");
  header.className = "note-card-header";
  const authorEl = document.createElement("span");
  authorEl.className = "note-card-author";
  authorEl.textContent = review.author || "Anonymous";
  const time = document.createElement("span");
  time.className = "note-card-time";
  time.textContent = review.createdAt?.toMillis ? formatRelativeTime(review.createdAt.toMillis()) : "";
  header.append(authorEl, time);

  const text = document.createElement("div");
  text.className = "note-card-text";
  text.textContent = review.text;

  card.append(deleteBtn, header, text);
  return card;
}

function buildCustomGameTeam(label, participants, game, teamId) {
  const wrap = document.createElement("div");
  wrap.className = "custom-game-team";

  // Damage share needs the team total, CS/min needs the clock; both computed once per side.
  const teamDamage = participants.reduce((sum, p) => sum + (p.damageToChampions || 0), 0);
  const minutes = game?.gameDurationSeconds ? game.gameDurationSeconds / 60 : 0;

  // In a tournament-draft custom the bans are a genuine team decision — show them with the side.
  const teamRecord = (game?.teams || []).find((t) => t.teamId === teamId);
  const banNames = (teamRecord?.bans || [])
    .map((id) => championsByKey[String(id)]?.name)
    .filter(Boolean);

  const won = participants.length > 0 && participants[0].win;
  const labelEl = document.createElement("div");
  labelEl.className = "custom-game-team-label" + (participants.length ? (won ? " win" : " loss") : "");
  labelEl.textContent = participants.length ? `${label} — ${won ? "Victory" : "Defeat"}` : label;
  wrap.appendChild(labelEl);

  if (banNames.length) {
    const bansEl = document.createElement("div");
    bansEl.className = "custom-game-bans";
    bansEl.textContent = `Bans: ${banNames.join(", ")}`;
    wrap.appendChild(bansEl);
  }

  participants.forEach((p) => {
    const row = document.createElement("div");
    row.className = "custom-game-participant";

    const champ = findChampionByKey(p.championId);
    const img = document.createElement("img");
    img.src = champ ? champ.image : "";
    img.alt = champ ? champ.name : String(p.championId);

    const name = document.createElement("div");
    name.className = "participant-name" + (p.matchedPersonName ? " matched" : "");
    name.textContent = p.matchedPersonName || p.summonerName || "Unknown";
    name.title = p.summonerName || "";

    const kda = document.createElement("div");
    kda.className = "participant-kda";
    kda.textContent = `${p.kills}/${p.deaths}/${p.assists}`;

    row.append(img, name, kda);

    // Games logged before the logger captured performance stats simply don't get the line —
    // KDA alone is what that game actually recorded.
    if (p.damageToChampions != null) {
      const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
      const share = teamDamage ? Math.round((p.damageToChampions / teamDamage) * 100) : 0;
      const csRate = minutes ? ` (${((p.cs || 0) / minutes).toFixed(1)}/m)` : "";
      const stats = document.createElement("div");
      stats.className = "participant-stats";
      stats.textContent =
        `${fmtK(p.damageToChampions)} dmg (${share}%) · ${p.cs || 0} CS${csRate} · ` +
        `${fmtK(p.goldEarned)} gold · ${p.visionScore || 0} vis`;
      row.appendChild(stats);
    }

    wrap.appendChild(row);
  });

  return wrap;
}

/* ---------- Rendering: Notes tab ---------- */

function renderNotesTab() {
  const person = getSelectedPerson();
  renderNotesPersonPicker(person);

  if (!person) {
    els.noPersonSelectedNotes.classList.remove("hidden");
    els.playerNotesContent.classList.add("hidden");
  } else {
    els.noPersonSelectedNotes.classList.add("hidden");
    els.playerNotesContent.classList.remove("hidden");
    els.notesPersonName.textContent = person.name;
    renderNotesList(
      els.playerNotesList,
      notes.filter((n) => n.type === "player" && n.personId === person.id)
    );
  }

  renderNotesList(
    els.draftNotesList,
    notes.filter((n) => n.type === "draft")
  );
}

function renderNotesPersonPicker(person) {
  const select = els.notesPersonSelect;
  // Rebuilding drops focus, which would fight someone mid-keyboard-selection.
  if (document.activeElement === select) return;

  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.people.length ? "Choose a player…" : "No players yet";
  select.appendChild(placeholder);

  state.people.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });

  select.value = person ? person.id : "";
  select.disabled = state.people.length === 0;
}

function renderNotesList(container, list) {
  container.innerHTML = "";
  if (list.length === 0) {
    container.innerHTML = `<p class="empty-state">No notes yet.</p>`;
    return;
  }

  list.forEach((note) => {
    const card = document.createElement("div");
    card.className = "note-card";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "remove-note";
    deleteBtn.textContent = "×";
    deleteBtn.title = "Delete note";
    deleteBtn.addEventListener("click", () => {
      if (confirm("Delete this note?")) deleteNote(note.id);
    });

    const header = document.createElement("div");
    header.className = "note-card-header";
    const author = document.createElement("span");
    author.className = "note-card-author";
    author.textContent = note.author || "Anonymous";
    const time = document.createElement("span");
    time.className = "note-card-time";
    time.textContent = note.createdAt?.toMillis ? formatRelativeTime(note.createdAt.toMillis()) : "";
    header.append(author, time);

    const text = document.createElement("div");
    text.className = "note-card-text";
    text.textContent = note.text;

    card.append(deleteBtn, header, text);
    container.appendChild(card);
  });
}

/* ---------- Rendering: Reviews tab ---------- */

/**
 * Just enough Markdown to make a coach's writeup readable: headings, bold, italics, inline
 * code, bullet lists, numbered lists and horizontal rules. Deliberately hand-rolled rather
 * than pulling in a parser — this file has no build step and no bundler, and a dependency
 * loaded off a CDN would be one more thing that can fail at page load.
 *
 * Everything is escaped BEFORE any markup is added, so a review can never inject HTML into
 * the page. That ordering is the whole safety story here; don't reverse it.
 */
function renderMarkdown(source) {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inline = (s) =>
    escape(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  const out = [];
  let listType = null; // "ul" | "ol" | null
  let paragraph = []; // consecutive plain lines waiting to be joined

  // Markdown treats a run of non-blank lines as ONE paragraph. Writeups are usually
  // hard-wrapped, so emitting a <p> per line turns every sentence into its own block --
  // buffer them instead and join on the blank line that actually ends the paragraph.
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  const closeList = () => {
    flushParagraph();
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const openList = (type) => {
    flushParagraph();
    if (listType !== type) {
      if (listType) out.push(`</${listType}>`);
      out.push(`<${type}>`);
      listType = type;
    }
  };

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      closeList();
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      closeList();
      out.push("<hr />");
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      // Shifted down one level: the page already owns <h2>, so a review's "#" must not
      // compete with it in the document outline.
      const level = Math.min(heading[1].length + 1, 5);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      openList("ul");
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      openList("ol");
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    // A plain line continues whatever paragraph is being built. If a list is open, the
    // paragraph starts fresh below it rather than being swallowed into the last <li>.
    if (listType) closeList();
    paragraph.push(line.trim());
  }

  closeList();
  return out.join("\n");
}

function renderReviewsTab() {
  if (!els.reviewsList) return;
  els.reviewsList.innerHTML = "";

  if (reviews.length === 0) {
    els.reviewsList.innerHTML = `<p class="empty-state">No reviews yet. Upload or paste one above and everyone will see it.</p>`;
    return;
  }

  reviews.forEach((review) => {
    const card = document.createElement("article");
    card.className = "review-card";

    const header = document.createElement("div");
    header.className = "review-card-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "review-toggle";
    const open = expandedReviewIds.has(review.id);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.innerHTML = `<span class="review-caret">${open ? "▾" : "▸"}</span><span class="review-title"></span>`;
    toggle.querySelector(".review-title").textContent = review.title || "Untitled review";
    toggle.addEventListener("click", () => {
      if (expandedReviewIds.has(review.id)) expandedReviewIds.delete(review.id);
      else expandedReviewIds.add(review.id);
      renderReviewsTab();
    });

    const meta = document.createElement("span");
    meta.className = "review-card-meta";
    const when = review.createdAt?.toMillis ? formatRelativeTime(review.createdAt.toMillis()) : "";
    meta.textContent = [review.author || "Anonymous", when].filter(Boolean).join(" · ");

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "remove-note";
    deleteBtn.textContent = "×";
    deleteBtn.title = "Delete review";
    deleteBtn.addEventListener("click", () => {
      if (confirm(`Delete "${review.title || "this review"}"? This removes it for everyone.`)) {
        deleteNote(review.id);
      }
    });

    header.append(toggle, meta, deleteBtn);
    card.append(header);

    if (open) {
      const body = document.createElement("div");
      body.className = "review-body markdown-body";
      body.innerHTML = renderMarkdown(review.text || "");
      card.append(body);
    }

    els.reviewsList.appendChild(card);
  });
}

// Same "notes" collection as everything else on purpose: the Firestore rules name each
// collection explicitly, so a brand-new one is denied until someone edits them in the
// console. A new *type* needs no rule change at all.
async function addReview(title, author, text) {
  const id = crypto.randomUUID();
  try {
    await setDoc(noteDoc(id), {
      type: "review",
      title,
      author: author || null,
      text,
      createdAt: new Date(),
    });
    expandedReviewIds.add(id);
  } catch (err) {
    console.error(err);
    alert("Could not post that review — check your connection and try again.");
  }
}

/* ---------- Rendering: Draft tab ---------- */

function renderDraftTab() {
  // Don't clobber the input while someone's actively typing a team name.
  if (document.activeElement !== els.blueTeamNameInput) {
    els.blueTeamNameInput.value = draftState.blueTeamName;
  }
  if (document.activeElement !== els.redTeamNameInput) {
    els.redTeamNameInput.value = draftState.redTeamName;
  }
  els.blueBoardLabel.textContent = draftState.blueTeamName;
  els.redBoardLabel.textContent = draftState.redTeamName;

  const index = draftState.actions.length;
  const isComplete = index >= DRAFT_SEQUENCE.length;

  if (isComplete) {
    els.draftPhaseLabel.textContent = "Draft Complete";
    els.draftTurnLabel.textContent = "All picks and bans are locked in.";
    els.draftTurnLabel.className = "draft-turn-label";
  } else {
    const current = DRAFT_SEQUENCE[index];
    const phaseNumber = current.type === "ban" ? (index < 6 ? 1 : 2) : index < 12 ? 1 : 2;
    els.draftPhaseLabel.textContent = `${current.type === "ban" ? "Ban" : "Pick"} Phase ${phaseNumber}`;
    const teamName = current.side === "blue" ? draftState.blueTeamName : draftState.redTeamName;
    els.draftTurnLabel.textContent = `${teamName}'s turn to ${current.type}`;
    els.draftTurnLabel.className = "draft-turn-label " + current.side;
  }

  els.undoDraftBtn.disabled = draftState.actions.length === 0;

  renderDraftBoard();
  renderDraftChampionGrid();
  renderDraftHistory();
}

// The draft is stored as one ordered list of champion ids; DRAFT_SEQUENCE is what says which
// of them was whose ban and whose pick. Shared by the board and by saved results.
function decomposeDraft(actions) {
  const out = { blueBans: [], bluePicks: [], redBans: [], redPicks: [] };
  (actions || []).forEach((championId, i) => {
    const step = DRAFT_SEQUENCE[i];
    if (!step) return;
    const key = `${step.side}${step.type === "ban" ? "Bans" : "Picks"}`;
    out[key].push(championId);
  });
  return out;
}

function renderDraftBoard() {
  const { blueBans, bluePicks, redBans, redPicks } = decomposeDraft(draftState.actions);

  renderDraftBanRow(els.blueBans, blueBans);
  renderDraftBanRow(els.redBans, redBans);
  renderDraftPickColumn(els.bluePicks, bluePicks);
  renderDraftPickColumn(els.redPicks, redPicks);
}

function renderDraftBanRow(container, championIds) {
  container.innerHTML = "";
  championIds.forEach((id) => {
    const champ = championsById[id];
    const img = document.createElement("img");
    img.src = champ ? champ.image : "";
    img.alt = champ ? champ.name : id;
    img.title = champ ? champ.name : id;
    container.appendChild(img);
  });
}

function renderDraftPickColumn(container, championIds) {
  const totalSlots = 5;
  container.innerHTML = "";
  for (let i = 0; i < totalSlots; i++) {
    const id = championIds[i];
    if (!id) {
      const empty = document.createElement("div");
      empty.className = "draft-pick-row empty";
      empty.textContent = `Pick ${i + 1}`;
      container.appendChild(empty);
      continue;
    }

    const champ = championsById[id];
    const row = document.createElement("div");
    row.className = "draft-pick-row";

    const slot = document.createElement("span");
    slot.className = "draft-pick-slot";
    slot.textContent = `${i + 1}.`;

    const img = document.createElement("img");
    img.src = champ ? champ.image : "";
    img.alt = champ ? champ.name : id;

    const name = document.createElement("span");
    name.className = "draft-pick-name";
    name.textContent = champ ? champ.name : id;

    row.append(slot, img, name);
    container.appendChild(row);
  }
}

function renderDraftChampionGrid() {
  const query = draftChampionSearch.trim().toLowerCase();
  const usedIds = new Set(draftState.actions);
  const isComplete = draftState.actions.length >= DRAFT_SEQUENCE.length;

  els.draftChampionGrid.innerHTML = "";
  championList
    .filter((c) => c.name.toLowerCase().includes(query))
    .forEach((champ) => {
      const node = buildChampIcon(champ);
      const unavailable = usedIds.has(champ.id) || isComplete;
      if (unavailable) {
        node.classList.add("draft-unavailable");
      } else {
        node.addEventListener("click", () => pickDraftChampion(champ.id));
      }
      els.draftChampionGrid.appendChild(node);
    });
}

/* ---------- Rendering: Draft history ---------- */

function renderDraftHistory() {
  if (!els.draftHistorySummary) return;

  els.draftResultStatus.textContent = draftResultStatusText;
  els.draftResultStatus.classList.toggle("error", draftResultStatusIsError);

  els.draftHistorySummary.innerHTML = "";
  els.draftHistoryList.innerHTML = "";

  if (draftResults.length === 0) {
    els.draftHistorySummary.innerHTML =
      `<p class="empty-state">No drafts recorded yet. Play one out above, then say whether it won — after a handful of games this shows which picks are actually working.</p>`;
    return;
  }

  const stats = draftResultStats();

  const headline = document.createElement("div");
  headline.className = "draft-record-line";
  headline.textContent =
    `${stats.wins}W-${stats.losses}L over ${stats.games} recorded draft${stats.games === 1 ? "" : "s"} · ` +
    `blue ${stats.bySide.blue.wins}/${stats.bySide.blue.games} · red ${stats.bySide.red.wins}/${stats.bySide.red.games}`;
  els.draftHistorySummary.appendChild(headline);

  const columns = document.createElement("div");
  columns.className = "draft-record-columns";
  columns.appendChild(buildChampionRecordColumn("Our picks", stats.ours));
  columns.appendChild(buildChampionRecordColumn("Played against us", stats.theirs, "Win rate is ours, so a low number is a champion that keeps beating us."));
  els.draftHistorySummary.appendChild(columns);

  draftResults.forEach((result) => els.draftHistoryList.appendChild(buildDraftResultCard(result)));
}

function buildChampionRecordColumn(title, rows, blurb) {
  const col = document.createElement("div");
  col.className = "draft-record-column";

  const heading = document.createElement("h4");
  heading.textContent = title;
  col.appendChild(heading);

  if (blurb) {
    const note = document.createElement("p");
    note.className = "flex-blurb";
    note.textContent = blurb;
    col.appendChild(note);
  }

  if (rows.length === 0) {
    col.innerHTML += `<p class="empty-state">Nothing yet.</p>`;
    return col;
  }

  rows.slice(0, 10).forEach((row) => {
    const champ = championsById[row.championId];
    const line = document.createElement("div");
    line.className = "flex-row";

    if (champ) {
      const img = document.createElement("img");
      img.src = champ.image;
      img.alt = champ.name;
      line.appendChild(img);
    }

    const name = document.createElement("span");
    name.className = "flex-champ-name";
    name.textContent = champ ? champ.name : row.championId;
    line.appendChild(name);

    const record = document.createElement("span");
    record.className = "flex-label";
    record.textContent = `${row.wins}-${row.games - row.wins} (${row.winRate}%)`;
    line.appendChild(record);

    col.appendChild(line);
  });

  return col;
}

function buildDraftResultCard(result) {
  const card = document.createElement("div");
  card.className = "draft-result-card " + (result.won ? "won" : "lost");

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "remove-note";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete this result";
  deleteBtn.addEventListener("click", () => {
    if (confirm("Delete this recorded draft?")) deleteDraftResult(result.id);
  });
  card.appendChild(deleteBtn);

  const header = document.createElement("div");
  header.className = "draft-result-header";
  const when = result.createdAt?.toMillis ? formatRelativeTime(result.createdAt.toMillis()) : "";
  header.textContent =
    `${result.won ? "Win" : "Loss"} on ${result.ourSide === "red" ? "red" : "blue"}` +
    `${result.complete ? "" : " · partial draft"}${when ? ` · ${when}` : ""}`;
  card.appendChild(header);

  const parts = decomposeDraft(result.actions);
  const ourSide = result.ourSide === "red" ? "red" : "blue";
  const rows = [
    ["Our picks", ourSide === "blue" ? parts.bluePicks : parts.redPicks],
    ["Their picks", ourSide === "blue" ? parts.redPicks : parts.bluePicks],
    ["Our bans", ourSide === "blue" ? parts.blueBans : parts.redBans],
    ["Their bans", ourSide === "blue" ? parts.redBans : parts.blueBans],
  ];

  rows.forEach(([label, ids]) => {
    if (!ids.length) return;
    const row = document.createElement("div");
    row.className = "draft-result-row";

    const name = document.createElement("span");
    name.className = "draft-result-row-label";
    name.textContent = label;
    row.appendChild(name);

    ids.forEach((id) => {
      const champ = championsById[id];
      if (!champ) return;
      const img = document.createElement("img");
      img.src = champ.image;
      img.alt = champ.name;
      img.title = champ.name;
      if (label.includes("bans")) img.className = "banned";
      row.appendChild(img);
    });

    card.appendChild(row);
  });

  return card;
}

/* ---------- Rendering: Strategy tab ---------- */

function renderStrategyTab() {
  els.strategyStatus.textContent = strategyStatusText;
  els.strategyStatus.classList.toggle("error", strategyStatusIsError);

  els.strategyList.innerHTML = "";
  if (strategies.length === 0) {
    els.strategyList.innerHTML = `<p class="empty-state">No strategy questions yet. Ask one above.</p>`;
    return;
  }

  strategies.forEach((entry) => {
    els.strategyList.appendChild(buildStrategyCard(entry));
  });
}

function buildStrategyCard(entry) {
  const card = document.createElement("div");
  card.className = "strategy-card" + (entry.status === "answered" ? " answered" : " pending");

  const header = document.createElement("div");
  header.className = "strategy-card-header";

  const badges = document.createElement("div");
  badges.className = "strategy-badges";

  const category = document.createElement("span");
  category.className = "strategy-category";
  category.textContent = entry.category || "General";

  const status = document.createElement("span");
  status.className = "strategy-status-badge " + (entry.status === "answered" ? "answered" : "pending");
  status.textContent = entry.status === "answered" ? "Answered" : "Waiting on Claude";

  badges.append(category, status);

  const meta = document.createElement("span");
  meta.className = "strategy-meta";
  const askedAt = entry.createdAt?.toMillis ? formatRelativeTime(entry.createdAt.toMillis()) : "";
  meta.textContent = [entry.askedBy || null, askedAt || null].filter(Boolean).join(" · ");

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "remove-note";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete this question";
  deleteBtn.addEventListener("click", () => {
    if (confirm("Delete this strategy question and its answer?")) deleteStrategy(entry.id);
  });

  header.append(badges, meta);
  card.append(deleteBtn, header);

  const question = document.createElement("div");
  question.className = "strategy-question";
  question.textContent = entry.question;
  card.appendChild(question);

  const actions = document.createElement("div");
  actions.className = "strategy-actions";

  if (entry.opggUrl) {
    const link = document.createElement("a");
    link.className = "strategy-opgg-link";
    link.href = entry.opggUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open op.gg multi-search";
    actions.appendChild(link);

    const rescoutBtn = document.createElement("button");
    rescoutBtn.type = "button";
    rescoutBtn.className = "strategy-small-btn";
    const isScouting = scoutingId === entry.id;
    rescoutBtn.disabled = isScouting;
    rescoutBtn.textContent = isScouting ? "Scouting…" : entry.scoutJson ? "Re-scout lobby" : "Scout lobby";
    rescoutBtn.addEventListener("click", () => scoutStrategy(entry));
    actions.appendChild(rescoutBtn);
  }

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "strategy-small-btn";
  copyBtn.textContent = "Copy for Claude";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(strategyBriefText(entry)).then(
      () => {
        copyBtn.textContent = "Copied";
        setTimeout(() => {
          copyBtn.textContent = "Copy for Claude";
        }, 1500);
      },
      () => setStrategyStatus("Could not copy — your browser blocked clipboard access.", true)
    );
  });
  actions.appendChild(copyBtn);

  card.appendChild(actions);

  if (entry.scoutError) {
    const err = document.createElement("div");
    err.className = "strategy-scout-error";
    err.textContent = `Scouting failed: ${entry.scoutError}`;
    card.appendChild(err);
  }

  const scout = parseScout(entry);
  if (scout) card.appendChild(buildScoutBlock(scout));

  if (entry.status === "answered" && entry.answer) {
    const answer = document.createElement("div");
    answer.className = "strategy-answer";

    const answerHeader = document.createElement("div");
    answerHeader.className = "strategy-answer-header";
    const answeredAt = entry.answeredAt?.toMillis ? ` · ${formatRelativeTime(entry.answeredAt.toMillis())}` : "";
    answerHeader.textContent = `Claude${answeredAt}`;
    answer.appendChild(answerHeader);

    renderAnswerInto(answer, entry.answer);
    card.appendChild(answer);
  }

  return card;
}

function buildScoutBlock(scout) {
  const wrap = document.createElement("div");
  wrap.className = "strategy-scout";

  const heading = document.createElement("div");
  heading.className = "strategy-scout-heading";
  const when = scout.fetchedAt ? formatRelativeTime(new Date(scout.fetchedAt).getTime()) : "";
  const depth = scout.sampleTarget || scout.matchesPerPlayer || RANKED_SAMPLE_TARGET;
  heading.textContent =
    `Lobby poll — up to ${depth} ranked games each (solo + flex)${when ? ` · ${when}` : ""}` +
    (scout.partial ? " · still running" : "");
  wrap.appendChild(heading);

  (scout.players || []).forEach((p) => {
    const row = document.createElement("div");
    row.className = "scout-player";

    const nameEl = document.createElement("div");
    nameEl.className = "scout-player-name" + (p.matchedPersonName ? " matched" : "");
    nameEl.textContent = p.matchedPersonName ? `${p.matchedPersonName} (${p.riotId})` : p.riotId;
    row.appendChild(nameEl);

    if (p.error) {
      const err = document.createElement("div");
      err.className = "scout-player-error";
      err.textContent = p.error;
      row.appendChild(err);
      wrap.appendChild(row);
      return;
    }

    const rank = document.createElement("div");
    rank.className = "scout-player-rank";
    const soloText = p.solo ? `${p.solo.tier} · ${p.solo.lp} LP · ${p.solo.wins}W/${p.solo.losses}L` : "Unranked (Solo/Duo)";
    const flexText = p.flex ? ` · Flex ${p.flex.tier}` : "";
    const roleText = (p.recent?.roles || []).length ? ` · ${p.recent.roles.map((r) => `${r.role} ×${r.games}`).join(" ")}` : "";
    rank.textContent = soloText + flexText + roleText;
    row.appendChild(rank);

    const r = p.recent || {};
    if (r.games) {
      const sample = document.createElement("div");
      sample.className = "scout-player-sample";
      sample.textContent =
        `Last ${r.games} ranked: ${r.wins}W/${r.losses}L (${r.winRate}%) · ` +
        `solo ${r.soloGames}g ${r.soloWinRate}% · flex ${r.flexGames}g ${r.flexWinRate}%` +
        (r.scanned > r.games ? ` · found in their last ${r.scanned} games` : "");
      row.appendChild(sample);
    }

    const champs = document.createElement("div");
    champs.className = "scout-player-champs";
    if (!(r.champions || []).length) {
      champs.textContent = "No ranked games found in the window.";
    } else {
      r.champions.slice(0, 6).forEach((c) => champs.appendChild(buildScoutChampionRow(c)));
    }
    row.appendChild(champs);

    // Laning shape, side bias, objective habits, contested picks and rune/spell tendencies.
    // Rendered from the same formatter the CLI prints, so the tab and a pasted brief agree.
    const profile = formatScoutedPlayerProfile(p);
    if (profile.length) {
      const wrap = document.createElement("div");
      wrap.className = "scout-player-profile";
      profile.forEach((line) => {
        const el = document.createElement("div");
        el.className = "scout-profile-line";
        el.textContent = line;
        wrap.appendChild(el);
      });
      row.appendChild(wrap);
    }

    wrap.appendChild(row);
  });

  return wrap;
}

// One champion's line in a scouted player's pool. Win rate leads and is coloured, because it
// is the number the draft turns on; the sample size sits next to it so a 100% on two games
// can't be mistaken for a real one.
function buildScoutChampionRow(c) {
  const row = document.createElement("div");
  row.className = "scout-champ";

  const champ = findChampionByName(c.name);
  if (champ) {
    const img = document.createElement("img");
    img.src = champ.image;
    img.alt = champ.name;
    row.appendChild(img);
  }

  const name = document.createElement("span");
  name.className = "scout-champ-name";
  name.textContent = champ ? champ.name : c.name;
  row.appendChild(name);

  const rate = document.createElement("span");
  rate.className = "scout-champ-wr " + (c.games < 3 ? "thin" : c.winRate >= 60 ? "high" : c.winRate < 45 ? "low" : "");
  rate.textContent = `${c.winRate}%`;
  rate.title = c.games < 3 ? "Too few games to read much into" : "";
  row.appendChild(rate);

  const record = document.createElement("span");
  record.className = "scout-champ-detail";
  const split = [];
  if (c.solo.games) split.push(`solo ${c.solo.wins}/${c.solo.games}`);
  if (c.flex.games) split.push(`flex ${c.flex.wins}/${c.flex.games}`);
  record.textContent =
    `${c.wins}W-${c.games - c.wins}L${split.length ? ` (${split.join(", ")})` : ""} · ` +
    `${c.kda.toFixed(1)} KDA · ${c.dpm} DPM · ${c.damageShare}% dmg`;
  row.appendChild(record);

  return row;
}

// A deliberately small Markdown subset — enough for the shape an answer actually takes
// (headings, bullets, bold, champion names) and nothing else. Everything is built as DOM
// nodes rather than innerHTML, so an answer can never inject markup into the page.
function renderAnswerInto(container, text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let list = null;
  let paragraph = null;
  let table = null;

  const closeBlocks = () => {
    list = null;
    paragraph = null;
    table = null;
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      closeBlocks();
      return;
    }

    const heading = line.match(/^(#{2,4})\s+(.*)$/);
    if (heading) {
      closeBlocks();
      const el = document.createElement(heading[1].length === 2 ? "h4" : "h5");
      el.className = "strategy-answer-heading";
      appendInline(el, heading[2]);
      container.appendChild(el);
      return;
    }

    if (/^(---|\*\*\*)$/.test(line.trim())) {
      closeBlocks();
      container.appendChild(document.createElement("hr"));
      return;
    }

    // Pipe tables: a scouted lobby is naturally a table, so answers get to use one. The
    // |---|---| separator row is what marks the row above it as the header.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split("|");
      if (cells.every((c) => /^\s*:?-+:?\s*$/.test(c))) {
        if (table) table.headerDone = true;
        return;
      }

      if (!table) {
        const el = document.createElement("table");
        el.className = "strategy-answer-table";
        const head = document.createElement("thead");
        const bodyEl = document.createElement("tbody");
        el.append(head, bodyEl);
        container.appendChild(el);
        table = { head, body: bodyEl, rows: 0, headerDone: false };
        paragraph = null;
        list = null;
      }

      const tr = document.createElement("tr");
      cells.forEach((cell) => {
        // Row zero is the header only if a separator row follows; until then it goes in the
        // head and simply looks like a first row if none ever does.
        const td = document.createElement(table.rows === 0 ? "th" : "td");
        appendInline(td, cell.trim());
        tr.appendChild(td);
      });
      (table.rows === 0 ? table.head : table.body).appendChild(tr);
      table.rows++;
      return;
    }
    table = null;

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const wantedTag = bullet ? "UL" : "OL";
      if (!list || list.tagName !== wantedTag) {
        list = document.createElement(bullet ? "ul" : "ol");
        list.className = "strategy-answer-list";
        container.appendChild(list);
      }
      paragraph = null;
      const li = document.createElement("li");
      appendInline(li, (bullet || numbered)[1]);
      list.appendChild(li);
      return;
    }

    list = null;
    if (!paragraph) {
      paragraph = document.createElement("p");
      paragraph.className = "strategy-answer-p";
      container.appendChild(paragraph);
    } else {
      paragraph.appendChild(document.createTextNode(" "));
    }
    appendInline(paragraph, line.trim());
  });
}

// Inline markers, scanned in one pass: **bold**, `code`, and [[Champion]] which becomes an
// icon chip so a comp or ban list is readable at a glance instead of being a wall of names.
function appendInline(parent, text) {
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[\[([^\]]+)\]\]/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    if (match[1] !== undefined) {
      const strong = document.createElement("strong");
      // Recurse: a bolded champion name (**[[Ahri]]**) is a normal thing to write, and the
      // non-greedy ** match can never contain another **, so this cannot loop.
      appendInline(strong, match[1]);
      parent.appendChild(strong);
    } else if (match[2] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[2];
      parent.appendChild(code);
    } else {
      parent.appendChild(buildChampionMention(match[3]));
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function buildChampionMention(name) {
  const champ = findChampionByName(name.trim());
  const chip = document.createElement("span");
  chip.className = "champ-mention";

  if (champ) {
    const img = document.createElement("img");
    img.src = champ.image;
    img.alt = champ.name;
    chip.appendChild(img);
  }

  const label = document.createElement("span");
  label.textContent = champ ? champ.name : name.trim();
  chip.appendChild(label);

  return chip;
}
