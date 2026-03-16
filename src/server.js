// src/server.js
import Fastify from "fastify";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ============================================
// CONFIG
// ============================================
const PORT = Number(process.env.LOG_PORT) || 4100;
const INGEST_KEY = process.env.LOG_INGEST_KEY || "zmien-ten-klucz-2026";
const ADMIN_USER = process.env.LOG_ADMIN_USER || "admin";
const ADMIN_PASS = process.env.LOG_ADMIN_PASS || "zmien-to-haslo-2026";
const DB_PATH = process.env.LOG_DB_PATH || join(ROOT, "logs.db");
const MAX_ROWS = 500_000; // auto-cleanup po przekroczeniu

// ============================================
// DATABASE
// ============================================
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    host TEXT NOT NULL DEFAULT '',
    app TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT 'info',
    file TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    raw TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_host ON logs(host);
  CREATE INDEX IF NOT EXISTS idx_logs_app ON logs(app);
  CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
`);

// Prepared statements
const insertLog = db.prepare(`
  INSERT INTO logs (ts, host, app, level, file, message, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertMany = db.transaction((entries) => {
  for (const e of entries) {
    insertLog.run(e.ts, e.host, e.app, e.level, e.file, e.message, e.raw);
  }
});

const countLogs = db.prepare("SELECT COUNT(*) as cnt FROM logs");
const deleteOld = db.prepare(`
  DELETE FROM logs WHERE id IN (
    SELECT id FROM logs ORDER BY ts ASC LIMIT ?
  )
`);

// ============================================
// HELPERS
// ============================================
function detectLevel(message) {
  const lower = message.toLowerCase();
  if (
    lower.includes("error") ||
    lower.includes("err_") ||
    lower.includes("fatal")
  )
    return "error";
  if (lower.includes("warn")) return "warn";
  if (lower.includes("debug")) return "debug";
  return "info";
}

function detectApp(file, host) {
  if (!file) return host || "unknown";
  if (file.includes("stojan-backend")) return "stojan-backend";
  if (file.includes("stojan-frontend")) return "stojan-frontend";
  if (file.includes("smart-copy") || file.includes("smart-backend"))
    return "smart-copy";
  if (file.includes("smart-edu")) return "smart-edu";
  if (file.includes("maturapolski") || file.includes("matura"))
    return "maturapolski";
  if (file.includes("interpunkcja")) return "interpunkcja";
  if (file.includes("copywriting24")) return "copywriting24";
  if (file.includes("web.stdout")) return "scraper";
  if (file.includes("nginx/access")) return "nginx-access";
  if (file.includes("nginx/error")) return "nginx-error";
  if (file.includes("/var/log/messages")) return "syslog";
  if (file.includes("/var/log/secure")) return "syslog-secure";
  return file.split("/").pop()?.replace(".log", "") || "unknown";
}

function extractHostShort(hostname) {
  if (!hostname) return "unknown";
  if (hostname.includes("172-31-36-197")) return "stojan";
  if (hostname.includes("172-31-37-15")) return "scraper";
  if (hostname.includes("172-31-21-124")) return "frankfurt-1";
  if (hostname.includes("172-31-17-228")) return "frankfurt-2";
  return hostname.split(".")[0];
}

function cleanup() {
  const { cnt } = countLogs.get();
  if (cnt > MAX_ROWS) {
    const toDelete = cnt - MAX_ROWS + 50_000; // delete 50k extra
    deleteOld.run(toDelete);
    console.log(`🧹 Cleaned ${toDelete} old logs (was ${cnt})`);
  }
}

// ============================================
// FASTIFY
// ============================================
const app = Fastify({ bodyLimit: 10_485_760 }); // 10MB

// --- Basic auth helper ---
function checkBasicAuth(request, reply) {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    reply.header("WWW-Authenticate", 'Basic realm="Logs"');
    reply.code(401).send("Unauthorized");
    return false;
  }
  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const [user, pass] = decoded.split(":");
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    reply.header("WWW-Authenticate", 'Basic realm="Logs"');
    reply.code(401).send("Unauthorized");
    return false;
  }
  return true;
}

// ============================================
// INGEST ENDPOINT — Vector sends logs here
// ============================================
app.post("/ingest", async (request, reply) => {
  // Check API key
  const key =
    request.headers["x-api-key"] ||
    request.headers["authorization"]?.replace("Bearer ", "");

  if (key !== INGEST_KEY) {
    return reply.code(401).send({ error: "Invalid API key" });
  }

  const body = request.body;
  const entries = [];

  // Vector sends single object or array
  const items = Array.isArray(body) ? body : [body];

  for (const item of items) {
    const message = item.message || item.msg || JSON.stringify(item);
    const host = extractHostShort(item.host || item.hostname || "");
    const file = item.file || item.source || "";
    const app = detectApp(file, host);
    const level = item.level || item.severity || detectLevel(message);
    const ts = item.timestamp || item.ts || item.dt || new Date().toISOString();

    entries.push({
      ts: typeof ts === "string" ? ts : new Date(ts).toISOString(),
      host,
      app,
      level,
      file,
      message: message.substring(0, 10000), // truncate
      raw: JSON.stringify(item).substring(0, 20000),
    });
  }

  if (entries.length > 0) {
    insertMany(entries);
  }

  // Periodic cleanup
  if (Math.random() < 0.01) cleanup(); // 1% chance per request

  return { ok: true, count: entries.length };
});

// ============================================
// API ENDPOINTS — Dashboard queries
// ============================================
app.get("/api/logs", async (request, reply) => {
  if (!checkBasicAuth(request, reply)) return;

  const {
    limit = "100",
    offset = "0",
    host,
    app: appFilter,
    level,
    search,
    from,
    to,
  } = request.query;

  let sql = "SELECT id, ts, host, app, level, message FROM logs WHERE 1=1";
  const params = [];

  if (host) {
    sql += " AND host = ?";
    params.push(host);
  }
  if (appFilter) {
    sql += " AND app = ?";
    params.push(appFilter);
  }
  if (level) {
    sql += " AND level = ?";
    params.push(level);
  }
  if (search) {
    sql += " AND message LIKE ?";
    params.push(`%${search}%`);
  }
  if (from) {
    sql += " AND ts >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND ts <= ?";
    params.push(to);
  }

  sql += " ORDER BY ts DESC LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));

  const rows = db.prepare(sql).all(...params);
  return { logs: rows, count: rows.length };
});

app.get("/api/stats", async (request, reply) => {
  if (!checkBasicAuth(request, reply)) return;

  const total = countLogs.get().cnt;
  const hosts = db
    .prepare("SELECT DISTINCT host FROM logs ORDER BY host")
    .all();
  const apps = db.prepare("SELECT DISTINCT app FROM logs ORDER BY app").all();
  const levels = db
    .prepare(
      "SELECT level, COUNT(*) as cnt FROM logs GROUP BY level ORDER BY cnt DESC",
    )
    .all();
  const recent_errors = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM logs WHERE level = 'error' AND ts > datetime('now', '-1 hour')",
    )
    .get();
  const db_size_bytes = db
    .prepare(
      "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()",
    )
    .get();

  return {
    total,
    hosts: hosts.map((h) => h.host),
    apps: apps.map((a) => a.app),
    levels,
    errors_last_hour: recent_errors.cnt,
    db_size_mb:
      Math.round(((db_size_bytes?.size || 0) / 1024 / 1024) * 10) / 10,
  };
});

// ============================================
// STATIC FILES — Dashboard UI
// ============================================
app.get("/", async (request, reply) => {
  if (!checkBasicAuth(request, reply)) return;
  const html = readFileSync(join(ROOT, "public", "index.html"), "utf-8");
  reply.type("text/html").send(html);
});

app.get("/style.css", async (request, reply) => {
  const css = readFileSync(join(ROOT, "public", "style.css"), "utf-8");
  reply.type("text/css").send(css);
});

// ============================================
// START
// ============================================
app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`📋 Log server running on http://0.0.0.0:${PORT}`);
  console.log(
    `   Ingest: POST /ingest (x-api-key: ${INGEST_KEY.substring(0, 8)}...)`,
  );
  console.log(`   Dashboard: http://0.0.0.0:${PORT}/`);
  console.log(`   DB: ${DB_PATH}`);
});
