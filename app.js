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

function personDoc(id) {
  return doc(peopleCol, id);
}

function eventDoc(id) {
  return doc(eventsCol, id);
}

function teamCompDoc(id) {
  return doc(teamCompsCol, id);
}

const ROLES = ["Top", "Jungle", "Mid", "ADC", "Support", "Fill"];
const COMP_ROLES = ["Top", "Jungle", "Mid", "ADC", "Support"];
const TIERS = ["S", "A", "B", "C"];
const UI_STORAGE_KEY = "championPoolManager.ui.v1";
const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";

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

  await Promise.all([
    championPromise,
    firstPeopleSnapshotPromise,
    firstEventsSnapshotPromise,
    firstTeamCompsSnapshotPromise,
  ]);

  if (championDataError || peopleSnapshotError || eventsSnapshotError || teamCompsSnapshotError) {
    document.getElementById("loadingScreen").innerHTML =
      `<p style="color:#e05252">${championDataError ? "Failed to load champion data." : "Failed to connect to the shared roster."} Check your internet connection and reload.</p>`;
    console.error(championDataError || peopleSnapshotError || eventsSnapshotError || teamCompsSnapshotError);
    return;
  }

  // Re-render now that champion data and every shared collection are guaranteed loaded,
  // in case a snapshot arrived before champion data finished fetching.
  renderPeopleList();
  renderPoolTab();
  renderOverviewTab();
  renderCalendarTab();
  renderCompsTab();

  document.getElementById("loadingScreen").classList.add("hidden");
  els.app.classList.remove("hidden");
}

function cacheEls() {
  els.app = document.getElementById("app");
  els.patchBadge = document.getElementById("patchBadge");
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
}

function bindStaticEvents() {
  els.addPersonForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = els.newPersonName.value.trim();
    if (!name) return;
    const opgg = els.newPersonOpgg.value.trim();
    addPerson(name, opgg);
    els.newPersonName.value = "";
    els.newPersonOpgg.value = "";
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
  if (tab === "overview") renderOverviewTab();
  if (tab === "calendar") renderCalendarTab();
  if (tab === "comps") renderCompsTab();
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
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  championsById = {};
  championList.forEach((c) => (championsById[c.id] = c));
}

/* ---------- People ---------- */

async function addPerson(name, opgg) {
  const id = crypto.randomUUID();
  state.selectedPersonId = id;
  saveLocalUIState();
  try {
    await setDoc(personDoc(id), { name, opgg: normalizeUrl(opgg), pool: [] });
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

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.innerHTML = `<th>Player</th>` + ROLES.map((r) => `<th>${r}</th>`).join("");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  state.people.forEach((person) => {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.className = "person-cell";
    nameCell.textContent = person.name;
    row.appendChild(nameCell);

    ROLES.forEach((role) => {
      const cell = document.createElement("td");
      const champsForRole = person.pool.filter((entry) => entry.role === role);
      if (champsForRole.length === 0) {
        cell.innerHTML = `<span class="no-champs">—</span>`;
      } else {
        const wrap = document.createElement("div");
        wrap.className = "role-champs";
        const tierRank = (t) => (t ? TIERS.indexOf(t) : TIERS.length);
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
        cell.appendChild(wrap);
      }
      row.appendChild(cell);
    });

    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  els.coverageTable.appendChild(table);
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
