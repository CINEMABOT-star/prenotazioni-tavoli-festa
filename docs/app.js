const state = {
  maps: [],
  tables: [],
  reservations: [],
  selectedTableNumber: null,
  mode: "idle",
  sort: { key: "tableNumber", direction: "asc" },
  search: "",
  storage: "server"
};

const $ = (id) => document.getElementById(id);
const API_BASE = String(window.APP_CONFIG?.apiBaseUrl || "").replace(/\/+$/, "");
const SUPABASE_URL = String(window.APP_CONFIG?.supabaseUrl || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = String(window.APP_CONFIG?.supabaseAnonKey || "");
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Errore richiesta");
  return data;
}

async function loadInitialData() {
  if (hasSupabase) {
    const tablesData = await loadStaticTables();
    state.tables = tablesData.tables;
    const reservations = await loadSupabaseReservations();
    state.storage = "supabase";
    return { tablesData, reservations };
  }

  try {
    const [tablesData, reservationsData] = await Promise.all([
      api("/api/tables"),
      api("/api/reservations")
    ]);
    state.storage = "server";
    return { tablesData, reservations: reservationsData.reservations };
  } catch {
    const tablesData = await loadStaticTables();
    state.storage = "local";
    return { tablesData, reservations: loadLocalReservations() };
  }
}

async function loadStaticTables() {
  const tablesResponse = await fetch("tables.json", { cache: "no-store" });
  if (!tablesResponse.ok) throw new Error("Configurazione tavoli non trovata");
  return tablesResponse.json();
}

function loadLocalReservations() {
  try {
    return JSON.parse(localStorage.getItem("tableReservations") || "[]");
  } catch {
    return [];
  }
}

function saveLocalReservations() {
  localStorage.setItem("tableReservations", JSON.stringify(state.reservations));
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {})
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || "Errore Supabase");
  }
  return data;
}

function fromSupabaseReservation(row) {
  const table = tableByNumber(row.table_number);
  return {
    id: row.id,
    tableNumber: Number(row.table_number),
    name: row.name,
    people: Number(row.people),
    phone: row.phone || "",
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    table
  };
}

function toSupabaseReservation(payload) {
  return {
    table_number: payload.tableNumber,
    name: payload.name.trim(),
    people: payload.people,
    phone: payload.phone.trim(),
    notes: payload.notes.trim()
  };
}

async function loadSupabaseReservations() {
  const rows = await supabaseRequest("reservations?select=*&order=table_number.asc");
  return rows.map(fromSupabaseReservation);
}

async function saveSupabaseReservation(payload, id) {
  const body = JSON.stringify(toSupabaseReservation(payload));
  if (id) {
    await supabaseRequest(`reservations?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body
    });
  } else {
    await supabaseRequest("reservations", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body
    });
  }
}

async function deleteSupabaseReservation(id) {
  await supabaseRequest(`reservations?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add("hidden"), 2800);
}

function tableByNumber(number) {
  return state.tables.find((table) => table.number === Number(number));
}

function reservationByTable(number) {
  return state.reservations.find((reservation) => reservation.tableNumber === Number(number));
}

function reservationById(id) {
  return state.reservations.find((reservation) => Number(reservation.id) === Number(id));
}

function tableLabel(table) {
  return `Tavolo ${table.number} - ${table.capacity} posti - ${table.area} - ${table.position}`;
}

function setWarning(message = "") {
  $("formWarning").textContent = message;
  $("formWarning").classList.toggle("hidden", !message);
}

async function boot() {
  const { tablesData, reservations } = await loadInitialData();
  state.maps = tablesData.maps;
  state.tables = tablesData.tables;
  state.reservations = reservations;
  renderMaps();
  renderAll();
}

function renderAll() {
  renderTableStates();
  renderSummary();
  renderReservationRows();
  renderSearchResults();
}

function renderSummary() {
  const booked = state.reservations.length;
  const total = state.tables.length;
  const people = state.reservations.reduce((sum, reservation) => sum + reservation.people, 0);
  const storageText = state.storage === "local" ? "salvato solo su questo dispositivo" : "database condiviso";
  $("summaryText").textContent = `${booked}/${total} tavoli prenotati - ${people} persone - ${storageText}`;
  $("listCount").textContent = `${booked} prenotazioni`;
}

function renderMaps() {
  const container = $("mapsContainer");
  container.innerHTML = "";

  for (const map of state.maps) {
    const panel = document.createElement("section");
    panel.className = "map-card";
    panel.dataset.map = map.id;

    const title = document.createElement("div");
    title.className = "map-title";
    title.innerHTML = `<h2>${map.label}</h2><span>${map.note || ""}</span>`;

    const stage = document.createElement("div");
    stage.className = "map-stage";
    stage.style.aspectRatio = `${map.width} / ${map.height}`;

    const image = document.createElement("img");
    image.src = map.image.startsWith("/")
      ? new URL(map.image.slice(1), document.baseURI).toString()
      : map.image;
    image.alt = `Piantina ${map.label}`;
    image.draggable = false;
    stage.append(image);

    for (const table of state.tables.filter((item) => item.map === map.id)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "table-marker";
      button.dataset.table = table.number;
      button.style.left = `${(table.x / map.width) * 100}%`;
      button.style.top = `${(table.y / map.height) * 100}%`;
      button.style.width = `${(table.w / map.width) * 100}%`;
      button.style.height = `${(table.h / map.height) * 100}%`;
      button.innerHTML = `<strong>${table.number}</strong><span>${table.capacity}</span>`;
      button.title = tableLabel(table);
      button.addEventListener("click", () => selectTable(table.number));
      stage.append(button);
    }

    panel.append(title, stage);
    container.append(panel);
  }
}

function renderTableStates() {
  const occupied = new Set(state.reservations.map((reservation) => reservation.tableNumber));
  document.querySelectorAll(".table-marker").forEach((button) => {
    const number = Number(button.dataset.table);
    button.classList.toggle("booked", occupied.has(number));
    button.classList.toggle("selected", state.selectedTableNumber === number);
    button.classList.toggle("search-match", isSearchMatch(number));
    const reservation = reservationByTable(number);
    button.title = reservation
      ? `${tableLabel(tableByNumber(number))} - ${reservation.name}, ${reservation.people} persone`
      : `${tableLabel(tableByNumber(number))} - libero`;
  });
}

function showPanel() {
  $("bookingPanel").classList.add("is-open");
  $("emptyPanel").classList.add("hidden");
  $("bookingForm").classList.remove("hidden");
}

function hidePanel() {
  state.selectedTableNumber = null;
  state.mode = "idle";
  $("bookingForm").reset();
  $("bookingForm").classList.add("hidden");
  $("emptyPanel").classList.remove("hidden");
  $("bookingPanel").classList.remove("is-open");
  setWarning("");
  renderTableStates();
}

function fillFormForTable(tableNumber) {
  const table = tableByNumber(tableNumber);
  const reservation = reservationByTable(tableNumber);
  state.selectedTableNumber = tableNumber;
  showPanel();
  setWarning("");

  $("selectedTableNumber").value = tableNumber;
  $("selectedTableText").textContent = tableLabel(table);
  $("preferenceGroup").classList.add("hidden");
  $("suggestBox").classList.add("hidden");

  if (reservation) {
    state.mode = "edit";
    $("panelTitle").textContent = "Modifica prenotazione";
    $("reservationId").value = reservation.id;
    $("bookingName").value = reservation.name;
    $("bookingPeople").value = reservation.people;
    $("bookingPhone").value = reservation.phone || "";
    $("bookingNotes").value = reservation.notes || "";
    $("saveButton").classList.add("hidden");
    $("editButton").classList.remove("hidden");
    $("deleteButton").classList.remove("hidden");
  } else {
    state.mode = "table-new";
    $("panelTitle").textContent = "Prenota tavolo";
    $("reservationId").value = "";
    $("bookingName").value = "";
    $("bookingPeople").value = "";
    $("bookingPhone").value = "";
    $("bookingNotes").value = "";
    $("saveButton").classList.remove("hidden");
    $("editButton").classList.add("hidden");
    $("deleteButton").classList.add("hidden");
  }
}

function openNewReservation() {
  state.mode = "suggest";
  state.selectedTableNumber = null;
  showPanel();
  $("bookingForm").reset();
  $("panelTitle").textContent = "Nuova prenotazione";
  $("selectedTableText").textContent = "Inserisci i dati e chiedi il suggerimento automatico";
  $("reservationId").value = "";
  $("selectedTableNumber").value = "";
  $("preferenceGroup").classList.remove("hidden");
  $("suggestBox").classList.remove("hidden");
  $("suggestText").textContent = "";
  $("saveButton").classList.remove("hidden");
  $("editButton").classList.add("hidden");
  $("deleteButton").classList.add("hidden");
  setWarning("");
  renderTableStates();
  $("bookingName").focus();
}

function selectTable(tableNumber) {
  const table = tableByNumber(tableNumber);
  const currentReservationId = Number($("reservationId").value || 0);
  const reservation = reservationByTable(tableNumber);

  if (state.mode === "suggest") {
    if (reservation) {
      toast(`Il tavolo ${tableNumber} e' gia prenotato`);
      return;
    }
    state.selectedTableNumber = tableNumber;
    $("selectedTableNumber").value = tableNumber;
    $("selectedTableText").textContent = `${tableLabel(table)} scelto manualmente`;
    setWarning("");
    renderTableStates();
    return;
  }

  if (state.mode === "edit" && currentReservationId) {
    if (reservation && Number(reservation.id) !== currentReservationId) {
      toast(`Il tavolo ${tableNumber} e' gia prenotato`);
      return;
    }
    state.selectedTableNumber = tableNumber;
    $("selectedTableNumber").value = tableNumber;
    $("selectedTableText").textContent = `${tableLabel(table)} scelto manualmente`;
    renderTableStates();
    return;
  }

  fillFormForTable(tableNumber);
  renderTableStates();
}

function formPayload() {
  return {
    tableNumber: Number($("selectedTableNumber").value),
    name: $("bookingName").value,
    people: Number($("bookingPeople").value),
    phone: $("bookingPhone").value,
    notes: $("bookingNotes").value
  };
}

function validateClient(payload) {
  const table = tableByNumber(payload.tableNumber);
  if (!table) return "Scegli un tavolo";
  if (!payload.name.trim()) return "Nome prenotazione obbligatorio";
  if (!Number.isInteger(payload.people) || payload.people < 1) return "Numero persone non valido";
  if (payload.people > table.capacity) {
    return `Il tavolo ${table.number} ha capienza ${table.capacity}: scegli un tavolo piu grande.`;
  }
  return "";
}

async function saveForm(event) {
  event.preventDefault();
  const payload = formPayload();
  const warning = validateClient(payload);
  if (warning) {
    setWarning(warning);
    return;
  }

  try {
    const id = Number($("reservationId").value || 0);
    if (state.storage === "supabase") {
      await saveSupabaseReservation(payload, id);
      toast(id ? "Prenotazione modificata" : "Prenotazione salvata");
    } else if (state.storage === "local") {
      saveLocalReservation(payload, id);
      toast(id ? "Prenotazione modificata" : "Prenotazione salvata");
    } else if (id) {
      await api(`/api/reservations/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("Prenotazione modificata");
    } else {
      await api("/api/reservations", { method: "POST", body: JSON.stringify(payload) });
      toast("Prenotazione salvata");
    }
    await refreshReservations();
    fillFormForTable(payload.tableNumber);
  } catch (error) {
    setWarning(error.message);
  }
}

async function deleteReservation() {
  const id = Number($("reservationId").value || 0);
  const reservation = reservationById(id);
  if (!reservation) return;
  if (!confirm(`Eliminare la prenotazione di ${reservation.name} al tavolo ${reservation.tableNumber}?`)) return;
  if (state.storage === "supabase") {
    await deleteSupabaseReservation(id);
  } else if (state.storage === "local") {
    state.reservations = state.reservations.filter((item) => Number(item.id) !== id);
    saveLocalReservations();
  } else {
    await api(`/api/reservations/${id}`, { method: "DELETE" });
  }
  toast("Prenotazione eliminata");
  await refreshReservations();
  fillFormForTable(reservation.tableNumber);
}

async function suggestTable() {
  const people = Number($("bookingPeople").value);
  const preference = document.querySelector("input[name='preference']:checked")?.value || "indifferente";
  if (!Number.isInteger(people) || people < 1) {
    setWarning("Inserisci il numero di persone prima del suggerimento");
    return;
  }
  try {
    if (state.storage === "local" || state.storage === "supabase") {
      const table = findLocalSuggestedTable(people, preference);
      applySuggestedTable(table);
      return;
    }
    const data = await api("/api/suggest", {
      method: "POST",
      body: JSON.stringify({ people, preference })
    });
    applySuggestedTable(data.table);
  } catch (error) {
    setWarning(error.message);
  }
}

function saveLocalReservation(payload, id) {
  const table = tableByNumber(payload.tableNumber);
  const existing = reservationByTable(payload.tableNumber);
  if (existing && Number(existing.id) !== Number(id)) {
    throw new Error(`Il tavolo ${payload.tableNumber} e' gia prenotato`);
  }

  if (id) {
    state.reservations = state.reservations.map((reservation) => (
      Number(reservation.id) === id
        ? { ...reservation, ...payload, table }
        : reservation
    ));
  } else {
    state.reservations.push({
      id: Date.now(),
      ...payload,
      table,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  saveLocalReservations();
  renderAll();
}

function findLocalSuggestedTable(people, preference) {
  const occupied = new Set(state.reservations.map((reservation) => reservation.tableNumber));
  return state.tables
    .filter((table) => !occupied.has(table.number))
    .filter((table) => table.capacity >= people)
    .filter((table) => preference === "indifferente" || table.area === preference)
    .sort((a, b) => {
      const wasteA = a.capacity - people;
      const wasteB = b.capacity - people;
      return wasteA - wasteB || a.capacity - b.capacity || a.number - b.number;
    })[0] || null;
}

function applySuggestedTable(table) {
  if (!table) {
    $("suggestText").textContent = "Nessun tavolo libero rispetta questi criteri";
    state.selectedTableNumber = null;
    $("selectedTableNumber").value = "";
    renderTableStates();
    return;
  }
  state.selectedTableNumber = table.number;
  $("selectedTableNumber").value = table.number;
  $("selectedTableText").textContent = `${tableLabel(table)} suggerito`;
  $("suggestText").textContent = `Suggerito tavolo ${table.number}. Puoi cliccare un altro tavolo libero sulla mappa per cambiarlo.`;
  setWarning("");
  renderTableStates();
  scrollToTable(table.number);
}

async function refreshReservations() {
  if (state.storage === "supabase") {
    state.reservations = await loadSupabaseReservations();
    renderAll();
    return;
  }
  if (state.storage === "local") {
    state.reservations = loadLocalReservations();
    renderAll();
    return;
  }
  const data = await api("/api/reservations");
  state.reservations = data.reservations;
  renderAll();
}

function renderReservationRows() {
  const rows = $("reservationRows");
  rows.innerHTML = "";

  const sorted = [...state.reservations].sort((a, b) => {
    const key = state.sort.key;
    const direction = state.sort.direction === "asc" ? 1 : -1;
    const av = key === "name" ? a.name.toLowerCase() : Number(a[key]);
    const bv = key === "name" ? b.name.toLowerCase() : Number(b[key]);
    return av > bv ? direction : av < bv ? -direction : a.tableNumber - b.tableNumber;
  });

  for (const reservation of sorted) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${reservation.tableNumber}</td>
      <td></td>
      <td>${reservation.people}</td>
      <td></td>
      <td>${reservation.table.area}</td>
      <td></td>
    `;
    row.children[1].textContent = reservation.name;
    row.children[3].textContent = reservation.phone || "";
    row.children[5].textContent = reservation.notes || "";
    row.addEventListener("click", () => {
      showView("map");
      fillFormForTable(reservation.tableNumber);
      scrollToTable(reservation.tableNumber);
      renderTableStates();
    });
    rows.append(row);
  }
}

function isSearchMatch(tableNumber) {
  if (!state.search) return false;
  const query = state.search.toLowerCase();
  const reservation = reservationByTable(tableNumber);
  return String(tableNumber) === query || reservation?.name.toLowerCase().includes(query);
}

function renderSearchResults() {
  const box = $("searchResults");
  box.innerHTML = "";
  if (!state.search) {
    box.classList.add("hidden");
    return;
  }

  const query = state.search.toLowerCase();
  const matches = state.tables
    .filter((table) => {
      const reservation = reservationByTable(table.number);
      return String(table.number).includes(query) || reservation?.name.toLowerCase().includes(query);
    })
    .slice(0, 10);

  if (matches.length === 0) {
    box.textContent = "Nessun risultato";
    box.classList.remove("hidden");
    return;
  }

  for (const table of matches) {
    const reservation = reservationByTable(table.number);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    button.textContent = reservation
      ? `Tavolo ${table.number} - ${reservation.name} (${reservation.people})`
      : `Tavolo ${table.number} - libero`;
    button.addEventListener("click", () => {
      showView("map");
      fillFormForTable(table.number);
      scrollToTable(table.number);
      renderTableStates();
    });
    box.append(button);
  }
  box.classList.remove("hidden");
}

function scrollToTable(tableNumber) {
  const marker = document.querySelector(`.table-marker[data-table="${tableNumber}"]`);
  marker?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
}

function showView(view) {
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  $("mapView").classList.toggle("hidden", view !== "map");
  $("listView").classList.toggle("hidden", view !== "list");
}

$("bookingForm").addEventListener("submit", saveForm);
$("deleteButton").addEventListener("click", () => deleteReservation().catch((error) => setWarning(error.message)));
$("newBookingButton").addEventListener("click", openNewReservation);
$("closePanelButton").addEventListener("click", hidePanel);
$("suggestButton").addEventListener("click", suggestTable);
$("clearSearchButton").addEventListener("click", () => {
  state.search = "";
  $("searchInput").value = "";
  renderAll();
});

$("searchInput").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderAll();
});

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

document.querySelectorAll(".sort-button").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    if (state.sort.key === key) {
      state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
    } else {
      state.sort = { key, direction: "asc" };
    }
    renderReservationRows();
  });
});

boot().catch((error) => {
  toast(error.message);
});
