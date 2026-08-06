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

function personDoc(id) {
  return doc(peopleCol, id);
}

const ROLES = ["Top", "Jungle", "Mid", "ADC", "Support", "Fill"];
const TIERS = ["S", "A", "B", "C"];
const UI_STORAGE_KEY = "championPoolManager.ui.v1";
const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";

let state = {
  people: [], // populated live from Firestore's "people" collection — shared across everyone
  selectedPersonId: null, // local-only UI preference (which tab you're viewing), not shared
};

let championsById = {}; // id -> { id, name, image }
let championList = []; // sorted array of champions
let ddragonVersion = "";

let opggEditingId = null; // person id whose OP.GG link is mid-edit, or null
let opggDraftValue = ""; // in-progress (unsaved) text for that edit

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
  let snapshotError = null;

  const championPromise = loadChampionData().catch((err) => {
    championDataError = err;
  });

  const firstSnapshotPromise = new Promise((resolve) => {
    onSnapshot(
      peopleCol,
      (snapshot) => {
        handlePeopleSnapshot(snapshot);
        resolve();
      },
      (err) => {
        snapshotError = err;
        resolve();
      }
    );
  });

  await Promise.all([championPromise, firstSnapshotPromise]);

  if (championDataError || snapshotError) {
    document.getElementById("loadingScreen").innerHTML =
      `<p style="color:#e05252">${championDataError ? "Failed to load champion data." : "Failed to connect to the shared roster."} Check your internet connection and reload.</p>`;
    console.error(championDataError || snapshotError);
    return;
  }

  // Re-render now that champion data and the roster are both guaranteed loaded,
  // in case the first roster snapshot arrived before champion data finished fetching.
  renderPeopleList();
  renderPoolTab();
  renderOverviewTab();

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
  els.coverageWarnings = document.getElementById("coverageWarnings");
  els.coverageTable = document.getElementById("coverageTable");
  els.championIconTemplate = document.getElementById("championIconTemplate");
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
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("poolTab").classList.toggle("active", tab === "pool");
  document.getElementById("overviewTab").classList.toggle("active", tab === "overview");
  if (tab === "overview") renderOverviewTab();
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
    alert("Could not add that person — check your connection and try again.");
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
    alert("Could not remove that person — check your connection and try again.");
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
    els.coverageTable.innerHTML = `<p class="empty-state">Add people to see role coverage.</p>`;
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
  headRow.innerHTML = `<th>Person</th>` + ROLES.map((r) => `<th>${r}</th>`).join("");
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
