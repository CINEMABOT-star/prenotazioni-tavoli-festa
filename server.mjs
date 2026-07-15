import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(process.cwd(), "public");
const DATA_DIR = path.join(process.cwd(), "data");
const MAX_TEXT_BYTES = 1024 * 1024;

mkdirSync(DATA_DIR, { recursive: true });

const passwordFile = path.join(DATA_DIR, "admin-password.txt");
const secretFile = path.join(DATA_DIR, "session-secret.bin");

async function loadOrCreatePassword() {
  if (process.env.REMOTE_HUB_PASSWORD) return process.env.REMOTE_HUB_PASSWORD;
  try {
    return (await fs.readFile(passwordFile, "utf8")).trim();
  } catch {
    const generated = crypto.randomBytes(18).toString("base64url");
    await fs.writeFile(passwordFile, `${generated}\n`, { mode: 0o600 });
    return generated;
  }
}

async function loadOrCreateSecret() {
  try {
    return await fs.readFile(secretFile);
  } catch {
    const secret = crypto.randomBytes(32);
    await fs.writeFile(secretFile, secret, { mode: 0o600 });
    return secret;
  }
}

const adminPassword = await loadOrCreatePassword();
const sessionSecret = await loadOrCreateSecret();

function uniqueExistingRoots() {
  const candidates = [
    ["workspace", "Workspace", process.cwd()],
    ["home", "Utente", os.homedir()],
    ["desktop", "Desktop", path.join(os.homedir(), "Desktop")],
    ["documents", "Documenti", path.join(os.homedir(), "Documents")],
    ["downloads", "Download", path.join(os.homedir(), "Downloads")]
  ];

  const seen = new Set();
  return candidates
    .filter(([, , p]) => existsSync(p))
    .map(([id, label, p]) => ({ id, label, path: path.resolve(p) }))
    .filter((root) => {
      const key = root.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const roots = uniqueExistingRoots();
const apps = [
  { id: "notepad", name: "Blocco note", command: "notepad.exe", args: [] },
  { id: "calc", name: "Calcolatrice", command: "calc.exe", args: [] },
  { id: "paint", name: "Paint", command: "mspaint.exe", args: [] },
  { id: "explorer_home", name: "Esplora file", command: "explorer.exe", args: [os.homedir()] },
  { id: "settings_apps", name: "Impostazioni app", command: "cmd.exe", args: ["/c", "start", "", "ms-settings:appsfeatures"] },
  { id: "settings_privacy", name: "Impostazioni privacy", command: "cmd.exe", args: ["/c", "start", "", "ms-settings:privacy"] }
];
const loginAttempts = new Map();

function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown");
}

function checkLoginWindow(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (!attempt) return;
  if (attempt.lockedUntil && attempt.lockedUntil > now) {
    const seconds = Math.ceil((attempt.lockedUntil - now) / 1000);
    throw httpError(429, `Troppi tentativi. Riprova tra ${seconds} secondi`);
  }
  if (attempt.resetAt <= now) loginAttempts.delete(ip);
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  const next = attempt && attempt.resetAt > now
    ? { ...attempt, count: attempt.count + 1 }
    : { count: 1, resetAt: now + 10 * 60 * 1000, lockedUntil: 0 };
  if (next.count >= 6) next.lockedUntil = now + 5 * 60 * 1000;
  loginAttempts.set(ip, next);
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({
    iat: Date.now(),
    exp: Date.now() + 12 * 60 * 60 * 1000,
    nonce: crypto.randomBytes(12).toString("base64url")
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function getToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.headers.cookie || "";
  const found = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("rh_session="));
  return found ? decodeURIComponent(found.slice("rh_session=".length)) : "";
}

function rootById(id) {
  const root = roots.find((item) => item.id === id);
  if (!root) throw httpError(404, "Root non trovata");
  return root;
}

function resolveInRoot(rootId, rel = ".") {
  const root = rootById(rootId);
  const rootPath = path.resolve(root.path);
  const target = path.resolve(rootPath, rel || ".");
  const relative = path.relative(rootPath, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(403, "Percorso non consentito");
  }
  return { root, rootPath, target, relative: relative || "." };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw httpError(413, "Richiesta troppo grande");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "JSON non valido");
  }
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sendText(res, text, status = 200, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(text);
}

function safeStaticPath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const target = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(requested)}`);
  const relative = path.relative(PUBLIC_DIR, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function launch(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    const ip = clientIp(req);
    checkLoginWindow(ip);
    const body = await readJson(req);
    const ok = typeof body.password === "string" && crypto.timingSafeEqual(
      crypto.createHash("sha256").update(body.password).digest(),
      crypto.createHash("sha256").update(adminPassword).digest()
    );
    if (!ok) {
      recordFailedLogin(ip);
      throw httpError(401, "Password non valida");
    }
    loginAttempts.delete(ip);
    const token = createSession();
    res.setHeader("Set-Cookie", `rh_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
    return sendJson(res, { token });
  }

  if (!verifySession(getToken(req))) throw httpError(401, "Accesso richiesto");

  if (req.method === "POST" && url.pathname === "/api/logout") {
    res.setHeader("Set-Cookie", "rh_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/");
    return sendJson(res, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    return sendJson(res, {
      user: os.userInfo().username,
      hostname: os.hostname(),
      platform: os.platform(),
      cwd: process.cwd(),
      roots,
      apps: apps.map(({ id, name }) => ({ id, name })),
      listen: { host: HOST, port: PORT }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/roots") {
    return sendJson(res, { roots });
  }

  if (req.method === "GET" && url.pathname === "/api/list") {
    const { target, rootPath, relative } = resolveInRoot(url.searchParams.get("root"), url.searchParams.get("path") || ".");
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const entries = await Promise.all(dirents.slice(0, 500).map(async (dirent) => {
      const full = path.join(target, dirent.name);
      let stats = null;
      try {
        stats = await fs.stat(full);
      } catch {}
      const childRel = path.relative(rootPath, full) || ".";
      return {
        name: dirent.name,
        path: childRel,
        type: dirent.isDirectory() ? "dir" : "file",
        size: stats?.size ?? 0,
        mtime: stats?.mtimeMs ?? 0
      };
    }));
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return sendJson(res, { path: relative, entries, truncated: dirents.length > 500 });
  }

  if (req.method === "GET" && url.pathname === "/api/read") {
    const { target, relative } = resolveInRoot(url.searchParams.get("root"), url.searchParams.get("path") || ".");
    const stats = await fs.stat(target);
    if (!stats.isFile()) throw httpError(400, "Non e' un file");
    if (stats.size > MAX_TEXT_BYTES) throw httpError(413, "File troppo grande per l'editor");
    const content = await fs.readFile(target, "utf8");
    return sendJson(res, { path: relative, content, size: stats.size, mtime: stats.mtimeMs });
  }

  if (req.method === "POST" && url.pathname === "/api/write") {
    const body = await readJson(req);
    const { target } = resolveInRoot(body.root, body.path);
    const content = String(body.content ?? "");
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw httpError(413, "Contenuto troppo grande");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/create") {
    const body = await readJson(req);
    const { target } = resolveInRoot(body.root, body.path);
    if (body.type === "folder") {
      await fs.mkdir(target, { recursive: false });
    } else {
      const handle = await fs.open(target, "wx");
      await handle.close();
    }
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/open-folder") {
    const body = await readJson(req);
    const { target } = resolveInRoot(body.root, body.path || ".");
    const stats = await fs.stat(target);
    const folder = stats.isDirectory() ? target : path.dirname(target);
    launch("explorer.exe", [folder]);
    return sendJson(res, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/download") {
    const { target } = resolveInRoot(url.searchParams.get("root"), url.searchParams.get("path") || ".");
    const stats = await fs.stat(target);
    if (!stats.isFile()) throw httpError(400, "Non e' un file");
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stats.size,
      "Content-Disposition": `attachment; filename="${path.basename(target).replaceAll("\"", "")}"`,
      "X-Content-Type-Options": "nosniff"
    });
    createReadStream(target).pipe(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps") {
    return sendJson(res, { apps: apps.map(({ id, name }) => ({ id, name })) });
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/apps/") && url.pathname.endsWith("/launch")) {
    const id = url.pathname.split("/")[3];
    const app = apps.find((item) => item.id === id);
    if (!app) throw httpError(404, "App non trovata");
    launch(app.command, app.args);
    return sendJson(res, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/permissions") {
    return sendJson(res, {
      actions: [
        { id: "settings_privacy", label: "Privacy Windows", appId: "settings_privacy" },
        { id: "settings_apps", label: "App installate", appId: "settings_apps" }
      ],
      note: "I permessi amministratore e UAC richiedono conferma locale o una sessione remota autenticata di sistema."
    });
  }

  throw httpError(404, "Endpoint non trovato");
}

async function handleStatic(req, res, url) {
  const target = safeStaticPath(url.pathname);
  if (!target) throw httpError(403, "Percorso non consentito");
  try {
    const stats = await fs.stat(target);
    if (!stats.isFile()) throw httpError(404, "File non trovato");
    res.writeHead(200, {
      "Content-Type": contentType(target),
      "Content-Length": stats.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'"
    });
    createReadStream(target).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") throw httpError(404, "File non trovato");
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await handleStatic(req, res, url);
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = error.status || 500;
    const message = status === 500 ? "Errore interno" : error.message;
    sendJson(res, { error: message }, status);
    if (status === 500) console.error(error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Remote Desk Hub: http://${HOST}:${PORT}`);
  console.log(`Utente: ${os.userInfo().username}@${os.hostname()}`);
  console.log(`Password: ${adminPassword}`);
  console.log("Per accesso remoto usa una VPN privata. Per ascoltare sulla rete: HOST=0.0.0.0 node server.mjs");
});
