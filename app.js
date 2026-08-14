import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  RIOT_PROXY_BASE,
  ROLE_DISPLAY_NAMES,
  aggregateStats,
  formatScoutedPlayer,
  parseOpggMultiSearch,
  riotErrorMessage,
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
const peopleCol = collection(db, "people");
const eventsCol = collection(db, "events");
const teamCompsCol = collection(db, "teamComps");
const customGamesCol = collection(db, "customGames");
const notesCol = collection(db, "notes");
const draftStateDocRef = doc(db, "draftState", "current");

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
const COMP_ROLES = ["Top", "Jungle", "Mid", "ADC", "Support"];
const TIERS = ["S", "A", "B", "C"];
const UI_STORAGE_KEY = "championPoolManager.ui.v1";
const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";
const STATS_MATCH_COUNT = 20;
const STRATEGY_CATEGORIES = ["General", "Team Comp", "Bans", "Draft", "Matchup", "Scouting"];
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
const TIMEZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [DEFAULT_TIMEZONE];

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
let matchesLoadingId = null; // person id currently fetching match data, or null
let statsCache = {}; // personId -> { games, wins, losses, kills, deaths, assists, roles, champions, loadError }
let statsLoadingId = null; // person id currently fetching stats, or null
let customGames = []; // populated live from Firestore's "customGames" collection — written by the local logger script

let notes = []; // populated live from Firestore's "notes" collection — shared across everyone
let draftState = { blueTeamName: "Blue Team", redTeamName: "Red Team", actions: [] }; // shared live draft
let draftChampionSearch = ""; // search text for the draft champion picker

let strategies = []; // populated live from Firestore's "strategies" collection — shared across everyone
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

async function init() {
  cacheEls();
  loadLocalUIState();
  bindStaticEvents();

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
    document.getElementById("loadingScreen").innerHTML =
      `<p style="color:#e05252">${championDataError ? "Failed to load champion data." : "Failed to connect to the shared roster."} Check your internet connection and reload.</p>`;
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

function cacheEls() {
  els.app = document.getElementById("app");
  els.patchBadge = document.getElementById("patchBadge");
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
  els.championIconTemplate = document.getElementById("championIconTemplate");
  els.addEventForm = document.getElementById("addEventForm");
  els.newEventTitle = document.getElementById("newEventTitle");
  els.newEventDate = document.getElementById("newEventDate");
  els.newEventTime = document.getElementById("newEventTime");
  els.newEventTimezone = document.getElementById("newEventTimezone");
  els.newEventNotes = document.getElementById("newEventNotes");
  els.calendarMonthLabel = document.getElementById("calendarMonthLabel");
  els.prevMonthBtn = document.getElementById("prevMonthBtn");
  els.nextMonthBtn = document.getElementById("nextMonthBtn");
  els.calendarGrid = document.getElementById("calendarGrid");
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
  els.statsStatus = document.getElementById("statsStatus");
  els.statsSummarySection = document.getElementById("statsSummarySection");
  els.statsRolesSection = document.getElementById("statsRolesSection");
  els.statsChampionsSection = document.getElementById("statsChampionsSection");
  els.customGamesList = document.getElementById("customGamesList");
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
  els.blueTeamNameInput = document.getElementById("blueTeamNameInput");
  els.redTeamNameInput = document.getElementById("redTeamNameInput");
  els.draftPhaseLabel = document.getElementById("draftPhaseLabel");
  els.draftTurnLabel = document.getElementById("draftTurnLabel");
  els.undoDraftBtn = document.getElementById("undoDraftBtn");
  els.resetDraftBtn = document.getElementById("resetDraftBtn");
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

  TIMEZONES.forEach((tz) => {
    const opt = document.createElement("option");
    opt.value = tz;
    opt.textContent = tz;
    els.newEventTimezone.appendChild(opt);
  });
  els.newEventTimezone.value = DEFAULT_TIMEZONE;

  els.addEventForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = els.newEventTitle.value.trim();
    const date = els.newEventDate.value;
    if (!title || !date) return;
    const time = els.newEventTime.value;
    const timezone = els.newEventTimezone.value || DEFAULT_TIMEZONE;
    const notes = els.newEventNotes.value.trim();
    addEvent(title, date, time, timezone, notes);
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

  STRATEGY_CATEGORIES.forEach((category) => {
    const opt = document.createElement("option");
    opt.value = category;
    opt.textContent = category;
    els.newStrategyCategory.appendChild(opt);
  });

  els.askStrategyForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = els.newStrategyQuestion.value.trim();
    if (!question) return;
    const opggUrl = els.newStrategyOpgg.value.trim();
    const category = els.newStrategyCategory.value;
    const author = els.newStrategyAuthor.value.trim();
    askStrategy(question, category, opggUrl, author);
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
  document.getElementById("draftTab").classList.toggle("active", tab === "draft");
  document.getElementById("strategyTab").classList.toggle("active", tab === "strategy");
  if (tab === "overview") renderOverviewTab();
  if (tab === "calendar") renderCalendarTab();
  if (tab === "comps") renderCompsTab();
  if (tab === "matches") renderMatchesTab();
  if (tab === "stats") renderStatsTab();
  if (tab === "customs") renderCustomsTab();
  if (tab === "notes") renderNotesTab();
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

  // One collection, two features: the Notes tab reads "player"/"draft" and the Strategy tab
  // reads "strategy". Splitting here keeps every renderer downstream unaware of the sharing.
  notes = all.filter((n) => n.type !== "strategy");
  strategies = all.filter((n) => n.type === "strategy");

  renderNotesTab();
  renderStrategyTab();
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

async function deleteNote(id) {
  try {
    await deleteDoc(noteDoc(id));
  } catch (err) {
    console.error(err);
    alert("Could not delete that note — check your connection and try again.");
  }
}

/* ---------- Strategy (questions for Claude + op.gg lobby scouting) ---------- */

async function askStrategy(question, category, opggUrl, author) {
  const id = crypto.randomUUID();
  const parsed = parseOpggMultiSearch(opggUrl);

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
      // A concrete client Date (not serverTimestamp()) so a new question sorts to the top
      // immediately instead of sitting as a null placeholder until the server confirms.
      createdAt: new Date(),
      scoutJson: null,
      scoutError: null,
    });
  } catch (err) {
    console.error(err);
    setStrategyStatus("Could not save that question — check your connection and try again.", true);
    return;
  }

  if (parsed.players.length > 0) {
    scoutStrategy({ id, opggUrl });
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
async function scoutStrategy(entry) {
  const parsed = parseOpggMultiSearch(entry.opggUrl);
  if (parsed.players.length === 0) {
    setStrategyStatus("No players found in that op.gg link.", true);
    return;
  }

  scoutingId = entry.id;
  setStrategyStatus(`Scouting ${parsed.players.length} player${parsed.players.length === 1 ? "" : "s"} through Riot…`, false);

  try {
    const scout = await scoutLobby(entry.opggUrl, state.people);
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
    const message = err.message || "Something went wrong scouting that lobby.";
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
    lines.push("", `Lobby scouted from Riot (last ${scout.matchesPerPlayer} games each):`);
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

    const roleSelect = document.createElement("select");
    roleSelect.className = "role-select";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "No role";
    roleSelect.appendChild(noneOpt);
    ROLES.forEach((role) => {
      const opt = document.createElement("option");
      opt.value = role;
      opt.textContent = role;
      if (entry.role === role) opt.selected = true;
      roleSelect.appendChild(opt);
    });
    roleSelect.addEventListener("click", (e) => e.stopPropagation());
    roleSelect.addEventListener("change", () => {
      updatePoolEntry(person, entry.championId, { role: roleSelect.value || null });
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

    node.append(tierSelect, roleSelect, removeBtn);
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
      : [...person.pool, { championId, role: null, tier: null }];
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

  if (state.people.length === 0) {
    els.coverageTable.innerHTML = `<p class="empty-state">Add players to see role coverage.</p>`;
    return;
  }

  const coreRoles = ["Top", "Jungle", "Mid", "ADC", "Support"];
  coreRoles.forEach((role) => {
    const hasCoverage = state.people.some((p) => p.pool.some((entry) => entry.role === role));
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

    const rolesWithChamps = ROLES.filter((role) => person.pool.some((entry) => entry.role === role));

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

        const champsForRole = person.pool.filter((entry) => entry.role === role);
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

function renderCalendarTab() {
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
  const tzAbbr = formatTimezoneAbbr(ev.date, ev.timezone || DEFAULT_TIMEZONE);
  titleEl.textContent = ev.time ? `${formatTime(ev.time)} ${tzAbbr} — ${ev.title}` : ev.title;

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

  const tzSelect = document.createElement("select");
  TIMEZONES.forEach((tz) => {
    const opt = document.createElement("option");
    opt.value = tz;
    opt.textContent = tz;
    if (tz === eventDraft.timezone) opt.selected = true;
    tzSelect.appendChild(opt);
  });
  tzSelect.addEventListener("change", () => (eventDraft.timezone = tzSelect.value));

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
      timezone: eventDraft.timezone || DEFAULT_TIMEZONE,
      notes: eventDraft.notes.trim() || null,
    };
    selectedCalendarDate = date;
    editingEventId = null;
    eventDraft = null;
    renderDayDetailPanel();
    updateEvent(ev.id, changes);
  });

  form.append(titleInput, dateInput, timeInput, tzSelect, notesInput, actions);
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

      const accountRes = await fetch(
        `${RIOT_PROXY_BASE}/account?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine)}`
      );
      const accountData = await accountRes.json();
      if (!accountRes.ok) {
        throw new Error(riotErrorMessage(accountData, "Could not find that Riot ID"));
      }
      puuid = accountData.puuid;
      // Cache the resolved puuid on the shared player doc so future loads (by anyone) skip this lookup.
      await updateDoc(personDoc(person.id), { puuid });
    }

    const [rankedRes, liveRes, matchIdsRes] = await Promise.all([
      fetch(`${RIOT_PROXY_BASE}/ranked?puuid=${puuid}`),
      fetch(`${RIOT_PROXY_BASE}/live?puuid=${puuid}`),
      fetch(`${RIOT_PROXY_BASE}/matches?puuid=${puuid}&count=5`),
    ]);
    const ranked = await rankedRes.json();
    const live = await liveRes.json();
    const matchIds = await matchIdsRes.json();

    if (!rankedRes.ok) throw new Error(riotErrorMessage(ranked, "Could not load ranked stats"));
    if (!liveRes.ok) throw new Error(riotErrorMessage(live, "Could not load live game status"));
    if (!matchIdsRes.ok) throw new Error(riotErrorMessage(matchIds, "Could not load match history"));

    const matches = await Promise.all(
      (Array.isArray(matchIds) ? matchIds : []).map((id) =>
        fetch(`${RIOT_PROXY_BASE}/match/${id}`).then((r) => r.json())
      )
    );

    matchesCache[person.id] = { ranked, live, matches, puuid };
  } catch (err) {
    console.error(err);
    matchesCache[person.id] = { loadError: err.message || "Something went wrong loading match data." };
  } finally {
    matchesLoadingId = null;
    renderMatchesTab();
  }
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
  heading.textContent = "Recent Matches";
  els.historySection.appendChild(heading);

  if (cached.matches.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No recent matches found.";
    els.historySection.appendChild(p);
    return;
  }

  cached.matches.forEach((match) => {
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

async function loadStatsData(person) {
  if (!person.riotId) return;

  statsLoadingId = person.id;
  renderStatsTab();

  try {
    let puuid = person.puuid || null;

    if (!puuid) {
      const [gameName, tagLine] = splitRiotId(person.riotId);
      if (!gameName || !tagLine) throw new Error("Riot ID should look like Name#Tag");

      const accountRes = await fetch(
        `${RIOT_PROXY_BASE}/account?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine)}`
      );
      const accountData = await accountRes.json();
      if (!accountRes.ok) throw new Error(riotErrorMessage(accountData, "Could not find that Riot ID"));
      puuid = accountData.puuid;
      await updateDoc(personDoc(person.id), { puuid });
    }

    const matchIdsRes = await fetch(`${RIOT_PROXY_BASE}/matches?puuid=${puuid}&count=${STATS_MATCH_COUNT}`);
    const matchIds = await matchIdsRes.json();
    if (!matchIdsRes.ok) throw new Error(riotErrorMessage(matchIds, "Could not load match history"));

    const matches = await Promise.all(
      (Array.isArray(matchIds) ? matchIds : []).map((id) => fetch(`${RIOT_PROXY_BASE}/match/${id}`).then((r) => r.json()))
    );

    statsCache[person.id] = aggregateStats(matches, puuid);
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

  renderStatsSummary(cached);
  renderStatsRoles(cached);
  renderStatsChampions(cached);
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

function renderStatsSummary(cached) {
  els.statsSummarySection.innerHTML = "";
  if (!cached || cached.loadError) return;
  if (cached.games === 0) {
    els.statsSummarySection.innerHTML = `<p class="empty-state">No matches found to analyze.</p>`;
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

  const gamesCard = buildStatCard("Games Analyzed", String(cached.games), "most recent matches");

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
  els.customGamesList.innerHTML = "";
  if (customGames.length === 0) {
    els.customGamesList.innerHTML = `<p class="empty-state">No custom games logged yet.</p>`;
    return;
  }
  customGames.forEach((game) => {
    els.customGamesList.appendChild(buildCustomGameCard(game));
  });
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
  teamsWrap.append(buildCustomGameTeam("Blue Side", blueSide), buildCustomGameTeam("Red Side", redSide));
  card.appendChild(teamsWrap);

  return card;
}

function buildCustomGameTeam(label, participants) {
  const wrap = document.createElement("div");
  wrap.className = "custom-game-team";

  const won = participants.length > 0 && participants[0].win;
  const labelEl = document.createElement("div");
  labelEl.className = "custom-game-team-label" + (participants.length ? (won ? " win" : " loss") : "");
  labelEl.textContent = participants.length ? `${label} — ${won ? "Victory" : "Defeat"}` : label;
  wrap.appendChild(labelEl);

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
    wrap.appendChild(row);
  });

  return wrap;
}

/* ---------- Rendering: Notes tab ---------- */

function renderNotesTab() {
  const person = getSelectedPerson();
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
}

function renderDraftBoard() {
  const blueBans = [];
  const bluePicks = [];
  const redBans = [];
  const redPicks = [];

  draftState.actions.forEach((championId, i) => {
    const step = DRAFT_SEQUENCE[i];
    if (!step) return;
    const target = step.side === "blue" ? (step.type === "ban" ? blueBans : bluePicks) : step.type === "ban" ? redBans : redPicks;
    target.push(championId);
  });

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
  heading.textContent = `Lobby scout — last ${scout.matchesPerPlayer} games each${when ? ` · ${when}` : ""}`;
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

    const champs = document.createElement("div");
    champs.className = "scout-player-champs";
    if (!(p.recent?.champions || []).length) {
      champs.textContent = "No recent games found.";
    } else {
      p.recent.champions.forEach((c) => {
        const chip = document.createElement("span");
        chip.className = "scout-champ";

        const champ = findChampionByName(c.name);
        if (champ) {
          const img = document.createElement("img");
          img.src = champ.image;
          img.alt = champ.name;
          chip.appendChild(img);
        }

        const label = document.createElement("span");
        const winRate = c.games > 0 ? Math.round((c.wins / c.games) * 100) : 0;
        const damage = c.dpm ? ` ${c.dpm} DPM ${c.damageShare}%` : "";
        label.textContent = `${champ ? champ.name : c.name} ${c.games}g ${winRate}% ${c.kda.toFixed(1)} KDA${damage}`;
        chip.appendChild(label);

        champs.appendChild(chip);
      });
    }
    row.appendChild(champs);

    wrap.appendChild(row);
  });

  return wrap;
}

// A deliberately small Markdown subset — enough for the shape an answer actually takes
// (headings, bullets, bold, champion names) and nothing else. Everything is built as DOM
// nodes rather than innerHTML, so an answer can never inject markup into the page.
function renderAnswerInto(container, text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let list = null;
  let paragraph = null;

  const closeBlocks = () => {
    list = null;
    paragraph = null;
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
