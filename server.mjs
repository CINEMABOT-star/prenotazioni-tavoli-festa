import express from "express";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "reservations.sqlite");
const TABLES_FILE = path.join(ROOT, "tables.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const tablesConfig = JSON.parse(fs.readFileSync(TABLES_FILE, "utf8"));
const tables = tablesConfig.tables
  .map((table) => ({ ...table, number: Number(table.number), capacity: Number(table.capacity) }))
  .sort((a, b) => a.number - b.number);
const tableByNumber = new Map(tables.map((table) => [table.number, table]));

if (tableByNumber.size !== tables.length) {
  throw new Error("tables.json contiene numeri tavolo duplicati");
}

const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tableNumber INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    people INTEGER NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const listReservationsStmt = db.prepare("SELECT * FROM reservations ORDER BY tableNumber");
const reservationByIdStmt = db.prepare("SELECT * FROM reservations WHERE id = ?");
const reservationByTableStmt = db.prepare("SELECT * FROM reservations WHERE tableNumber = ?");
const insertReservationStmt = db.prepare(`
  INSERT INTO reservations (tableNumber, name, people, phone, notes, updatedAt)
  VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);
const updateReservationStmt = db.prepare(`
  UPDATE reservations
  SET tableNumber = ?, name = ?, people = ?, phone = ?, notes = ?, updatedAt = CURRENT_TIMESTAMP
  WHERE id = ?
`);
const deleteReservationStmt = db.prepare("DELETE FROM reservations WHERE id = ?");

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanText(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeReservationInput(body) {
  const tableNumber = Number(body.tableNumber);
  const people = Number(body.people);
  const name = cleanText(body.name, 120);
  const phone = cleanText(body.phone, 50);
  const notes = cleanText(body.notes, 600);

  if (!Number.isInteger(tableNumber) || !tableByNumber.has(tableNumber)) {
    throw httpError(400, "Tavolo non valido");
  }
  if (!name) throw httpError(400, "Nome prenotazione obbligatorio");
  if (!Number.isInteger(people) || people < 1) {
    throw httpError(400, "Numero persone non valido");
  }

  const table = tableByNumber.get(tableNumber);
  if (people > table.capacity) {
    throw httpError(
      400,
      `Il tavolo ${tableNumber} ha capienza ${table.capacity}: non puoi prenotarlo per ${people} persone.`
    );
  }

  return { tableNumber, name, people, phone, notes, table };
}

function withTableInfo(reservation) {
  if (!reservation) return null;
  const table = tableByNumber.get(Number(reservation.tableNumber));
  return {
    ...reservation,
    tableNumber: Number(reservation.tableNumber),
    people: Number(reservation.people),
    table
  };
}

function findSuggestedTable(people, preference) {
  if (!Number.isInteger(people) || people < 1) {
    throw httpError(400, "Numero persone non valido");
  }
  const normalizedPreference = ["interno", "esterno", "indifferente"].includes(preference)
    ? preference
    : "indifferente";
  const occupied = new Set(listReservationsStmt.all().map((reservation) => Number(reservation.tableNumber)));

  const candidates = tables
    .filter((table) => !occupied.has(table.number))
    .filter((table) => table.capacity >= people)
    .filter((table) => normalizedPreference === "indifferente" || table.area === normalizedPreference)
    .sort((a, b) => {
      const wasteA = a.capacity - people;
      const wasteB = b.capacity - people;
      return wasteA - wasteB || a.capacity - b.capacity || a.number - b.number;
    });

  return candidates[0] || null;
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
}));

app.get("/api/tables", (req, res) => {
  res.json({ maps: tablesConfig.maps, tables });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/reservations", (req, res) => {
  res.json({ reservations: listReservationsStmt.all().map(withTableInfo) });
});

app.post("/api/reservations", (req, res) => {
  const input = normalizeReservationInput(req.body);
  const existing = reservationByTableStmt.get(input.tableNumber);
  if (existing) throw httpError(409, `Il tavolo ${input.tableNumber} e' gia prenotato`);

  insertReservationStmt.run(input.tableNumber, input.name, input.people, input.phone, input.notes);
  res.status(201).json({ reservation: withTableInfo(reservationByTableStmt.get(input.tableNumber)) });
});

app.put("/api/reservations/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(400, "Prenotazione non valida");
  const current = reservationByIdStmt.get(id);
  if (!current) throw httpError(404, "Prenotazione non trovata");

  const input = normalizeReservationInput(req.body);
  const existing = reservationByTableStmt.get(input.tableNumber);
  if (existing && Number(existing.id) !== id) {
    throw httpError(409, `Il tavolo ${input.tableNumber} e' gia prenotato`);
  }

  updateReservationStmt.run(input.tableNumber, input.name, input.people, input.phone, input.notes, id);
  res.json({ reservation: withTableInfo(reservationByIdStmt.get(id)) });
});

app.delete("/api/reservations/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(400, "Prenotazione non valida");
  deleteReservationStmt.run(id);
  res.json({ ok: true });
});

app.post("/api/suggest", (req, res) => {
  const people = Number(req.body.people);
  const preference = cleanText(req.body.preference, 20) || "indifferente";
  res.json({ table: findSuggestedTable(people, preference) });
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: status === 500 ? "Errore interno" : error.message });
});

app.listen(PORT, HOST, () => {
  console.log(`Prenotazioni tavoli: http://${HOST}:${PORT}`);
  console.log(`Database SQLite: ${DB_FILE}`);
});
