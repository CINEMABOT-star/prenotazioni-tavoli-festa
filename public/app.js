const state = {
  token: localStorage.getItem("remoteHubToken") || "",
  roots: [],
  apps: [],
  root: "",
  path: ".",
  currentFile: ""
};

const $ = (id) => document.getElementById(id);

function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return fetch(path, { ...options, headers }).then(async (res) => {
    const type = res.headers.get("Content-Type") || "";
    const data = type.includes("application/json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data.error || "Errore richiesta");
    return data;
  });
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add("hidden"), 2600);
}

function showLogin() {
  $("loginView").classList.remove("hidden");
  $("shellView").classList.add("hidden");
}

function showShell() {
  $("loginView").classList.add("hidden");
  $("shellView").classList.remove("hidden");
}

function normalizePath(value) {
  const trimmed = String(value || ".").trim();
  return trimmed || ".";
}

function parentPath(value) {
  const normalized = normalizePath(value).replaceAll("\\", "/");
  if (normalized === "." || !normalized.includes("/")) return ".";
  return normalized.split("/").slice(0, -1).join("/") || ".";
}

function formatSize(size) {
  if (!Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function boot() {
  if (!state.token) return showLogin();
  try {
    const me = await api("/api/me");
    state.roots = me.roots;
    state.apps = me.apps;
    state.root = state.roots[0]?.id || "";
    $("machineLabel").textContent = `${me.user}@${me.hostname}`;
    renderRoots();
    renderApps();
    await loadPermissions();
    showShell();
    if (state.root) await loadList(".");
  } catch {
    localStorage.removeItem("remoteHubToken");
    state.token = "";
    showLogin();
  }
}

function renderRoots() {
  $("rootSelect").innerHTML = "";
  for (const root of state.roots) {
    const option = document.createElement("option");
    option.value = root.id;
    option.textContent = root.label;
    $("rootSelect").append(option);
  }
  $("rootSelect").value = state.root;
}

async function loadList(nextPath = state.path) {
  state.path = normalizePath(nextPath);
  $("pathInput").value = state.path;
  const params = new URLSearchParams({ root: state.root, path: state.path });
  const data = await api(`/api/list?${params}`);
  const list = $("fileList");
  list.innerHTML = "";

  if (state.path !== ".") {
    list.append(fileRow({ name: "..", path: parentPath(state.path), type: "dir", size: 0 }, true));
  }

  for (const entry of data.entries) list.append(fileRow(entry, false));
  if (data.truncated) toast("Lista limitata ai primi 500 elementi");
}

function fileRow(entry, isParent) {
  const row = document.createElement("button");
  row.className = "file-row";
  row.type = "button";
  row.innerHTML = `
    <span>${entry.type === "dir" ? "DIR" : "TXT"}</span>
    <span class="file-name"></span>
    <span class="file-meta">${entry.type === "file" ? formatSize(entry.size) : ""}</span>
  `;
  row.querySelector(".file-name").textContent = entry.name;
  row.addEventListener("click", async () => {
    try {
      if (entry.type === "dir") {
        await loadList(entry.path);
      } else {
        await readFile(entry.path);
      }
    } catch (error) {
      toast(error.message);
    }
  });
  if (isParent) row.querySelector(".file-meta").textContent = "";
  return row;
}

async function readFile(filePath) {
  const params = new URLSearchParams({ root: state.root, path: filePath });
  const data = await api(`/api/read?${params}`);
  state.currentFile = data.path;
  $("editorPath").textContent = data.path;
  $("editorText").value = data.content;
  $("editorText").disabled = false;
  $("saveButton").disabled = false;
  $("downloadButton").disabled = false;
}

async function createEntry(type) {
  const name = $("newNameInput").value.trim();
  if (!name) return toast("Nome richiesto");
  const base = state.path === "." ? "" : `${state.path}/`;
  await api("/api/create", {
    method: "POST",
    body: JSON.stringify({ root: state.root, path: `${base}${name}`, type })
  });
  $("newNameInput").value = "";
  await loadList();
  toast(type === "folder" ? "Cartella creata" : "File creato");
}

function renderApps() {
  const grid = $("appGrid");
  grid.innerHTML = "";
  for (const app of state.apps) {
    grid.append(appTile(app.name, () => launchApp(app.id)));
  }
}

function appTile(label, onLaunch) {
  const tile = document.createElement("div");
  tile.className = "app-tile";
  const name = document.createElement("strong");
  name.textContent = label;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Apri";
  button.addEventListener("click", onLaunch);
  tile.append(name, button);
  return tile;
}

async function launchApp(id) {
  await api(`/api/apps/${id}/launch`, { method: "POST" });
  toast("Apertura inviata");
}

async function loadPermissions() {
  const data = await api("/api/permissions");
  $("permissionNote").textContent = data.note;
  const wrap = $("permissionActions");
  wrap.innerHTML = "";
  for (const action of data.actions) {
    wrap.append(appTile(action.label, () => launchApp(action.appId)));
  }
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("loginError").textContent = "";
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("password").value })
    });
    state.token = data.token;
    localStorage.setItem("remoteHubToken", state.token);
    await boot();
  } catch (error) {
    $("loginError").textContent = error.message;
  }
});

$("logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {}
  localStorage.removeItem("remoteHubToken");
  state.token = "";
  showLogin();
});

document.querySelectorAll(".nav").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((item) => item.classList.add("hidden"));
    button.classList.add("active");
    $(`${button.dataset.view}View`).classList.remove("hidden");
  });
});

$("rootSelect").addEventListener("change", async () => {
  state.root = $("rootSelect").value;
  state.path = ".";
  state.currentFile = "";
  $("editorText").value = "";
  $("editorText").disabled = true;
  $("saveButton").disabled = true;
  $("downloadButton").disabled = true;
  $("editorPath").textContent = "Nessun file";
  await loadList(".");
});

$("goButton").addEventListener("click", async () => {
  try {
    await loadList($("pathInput").value);
  } catch (error) {
    toast(error.message);
  }
});

$("openFolderButton").addEventListener("click", async () => {
  try {
    await api("/api/open-folder", {
      method: "POST",
      body: JSON.stringify({ root: state.root, path: state.path })
    });
    toast("Explorer aperto");
  } catch (error) {
    toast(error.message);
  }
});

$("newFileButton").addEventListener("click", () => createEntry("file").catch((error) => toast(error.message)));
$("newFolderButton").addEventListener("click", () => createEntry("folder").catch((error) => toast(error.message)));

$("saveButton").addEventListener("click", async () => {
  if (!state.currentFile) return;
  try {
    await api("/api/write", {
      method: "POST",
      body: JSON.stringify({ root: state.root, path: state.currentFile, content: $("editorText").value })
    });
    toast("File salvato");
    await loadList();
  } catch (error) {
    toast(error.message);
  }
});

$("downloadButton").addEventListener("click", () => {
  if (!state.currentFile) return;
  const params = new URLSearchParams({ root: state.root, path: state.currentFile });
  window.open(`/api/download?${params}`, "_blank", "noopener");
});

boot();
