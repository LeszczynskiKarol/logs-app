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
  // Stojan instance
  if (file.includes("stojan-backend")) return "stojan-backend";
  if (file.includes("stojan-frontend")) return "stojan-frontend";
  if (file.includes("stojan-logs")) return "stojan-logs";
  // Frankfurt-2: smart-copy, smart-edu, seo-panel
  if (file.includes("seo-panel-error")) return "seo-panel";
  if (file.includes("seo-panel-out")) return "seo-panel";
  if (file.includes("seo-panel")) return "seo-panel";
  if (file.includes("smart-backend") || file.includes("smart-copy"))
    return "smart-copy";
  if (file.includes("smart-edu")) return "smart-edu";
  // Frankfurt-1: maturapolski, interpunkcja, copywriting24
  if (file.includes("maturapolski") || file.includes("matura"))
    return "maturapolski";
  if (file.includes("interpunkcja")) return "interpunkcja";
  if (file.includes("copywriting24")) return "copywriting24";
  // Scraper
  if (file.includes("web.stdout") || file.includes("web.stderr"))
    return "scraper";
  // System logs
  if (file.includes("/var/log/messages")) return "syslog";
  if (file.includes("/var/log/secure")) return "syslog-secure";
  return (
    file
      .split("/")
      .pop()
      ?.replace(".log", "")
      .replace("-out", "")
      .replace("-error", "") || "unknown"
  );
}

function extractHostShort(hostname) {
  if (!hostname) return "unknown";
  if (hostname.includes("172-31-36-197")) return "Stojan (Stockholm)";
  if (hostname.includes("172-31-37-15")) return "Scraper (Stockholm)";
  if (hostname.includes("172-31-21-124"))
    return "Matura+Inter+Copy24 (Frankfurt)";
  if (hostname.includes("172-31-17-228"))
    return "SmartCopy+Edu+SEO-panel (Frankfurt)";
  return hostname.split(".")[0];
}

function cleanup() {
  const { cnt } = countLogs.get();
  if (cnt > MAX_ROWS) {
    const toDelete = cnt - MAX_ROWS + 50_000;
    deleteOld.run(toDelete);
    console.log(`🧹 Cleaned ${toDelete} old logs (was ${cnt})`);
  }
}

// ============================================
// LOG GROUPING — merge multi-line entries
// ============================================
// Rows come in DESC order (newest first).
// Consecutive rows with same host+app+file and timestamps within
// GROUP_WINDOW_MS are merged into one entry. Messages are
// reassembled in chronological (ASC) order so stack traces read
// correctly top-to-bottom.
const GROUP_WINDOW_MS = 2000;

function groupLogs(rows) {
  if (rows.length === 0) return rows;

  const grouped = [];
  // Accumulate lines for the current group (in DESC order as they arrive)
  let cur = { ...rows[0], _lines: [rows[0].message] };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const tsCur = new Date(cur.ts).getTime();
    const tsRow = new Date(row.ts).getTime();
    const timeDiff = Math.abs(tsCur - tsRow);

    const sameGroup =
      row.host === cur.host &&
      row.app === cur.app &&
      timeDiff <= GROUP_WINDOW_MS;

    if (sameGroup) {
      // Collect line; promote level if we see an error/warn
      cur._lines.push(row.message);
      if (row.level === "error") cur.level = "error";
      else if (row.level === "warn" && cur.level !== "error")
        cur.level = "warn";
    } else {
      // Flush current group — reverse so oldest line is first (chronological)
      cur.message = cur._lines.reverse().join("\n");
      delete cur._lines;
      grouped.push(cur);
      cur = { ...row, _lines: [row.message] };
    }
  }
  // Flush last group
  cur.message = cur._lines.reverse().join("\n");
  delete cur._lines;
  grouped.push(cur);

  return grouped;
}

// ============================================
// FASTIFY
// ============================================
const app = Fastify({ bodyLimit: 10_485_760 }); // 10MB

// --- Basic auth helper ---
function checkBasicAuth(request, reply) {
  const auth = request.headers.authorization;
  if (!auth || !startsWith(auth, "Basic ")) {
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

function startsWith(str, prefix) {
  return str.slice(0, prefix.length) === prefix;
}

// ============================================
// INGEST ENDPOINT — Vector sends logs here
// ============================================
app.post("/ingest", async (request, reply) => {
  const key =
    request.headers["x-api-key"] ||
    request.headers["authorization"]?.replace("Bearer ", "");

  if (key !== INGEST_KEY) {
    return reply.code(401).send({ error: "Invalid API key" });
  }

  const body = request.body;
  const entries = [];

  const items = Array.isArray(body) ? body : [body];

  for (const item of items) {
    const message = item.message || item.msg || JSON.stringify(item);
    const host = extractHostShort(item.host || item.hostname || "");
    const file = item.file || item.source || "";
    const app = detectApp(file, host);
    const level = item.level || item.severity || detectLevel(message);
    const ts = item.timestamp || item.ts || item.dt || new Date().toISOString();
    if (message.includes("buffered to a temporary file")) continue;
    if (file.includes("nginx/error") || file.includes("nginx/access")) continue;
    entries.push({
      ts: typeof ts === "string" ? ts : new Date(ts).toISOString(),
      host,
      app,
      level,
      file,
      message: message.substring(0, 10000),
      raw: JSON.stringify(item).substring(0, 20000),
    });
  }

  if (entries.length > 0) {
    insertMany(entries);
  }

  if (Math.random() < 0.01) cleanup();

  return { ok: true, count: entries.length };
});

// ============================================
// API ENDPOINTS — Dashboard queries
// ============================================
app.get("/api/logs", async (request, reply) => {
  if (!checkBasicAuth(request, reply)) return;

  const {
    limit = "30",
    before_id,
    host,
    app: appFilter,
    level,
    search,
    from,
    to,
  } = request.query;

  const wantedLimit = Number(limit);

  let whereSql = " WHERE 1=1";
  const whereParams = [];

  if (before_id) {
    whereSql += " AND id < ?";
    whereParams.push(Number(before_id));
  }
  if (host) {
    whereSql += " AND host = ?";
    whereParams.push(host);
  }
  if (appFilter) {
    whereSql += " AND app = ?";
    whereParams.push(appFilter);
  }
  if (level) {
    whereSql += " AND level = ?";
    whereParams.push(level);
  }
  if (search) {
    whereSql += " AND message LIKE ?";
    whereParams.push(`%${search}%`);
  }
  if (from) {
    whereSql += " AND ts >= ?";
    whereParams.push(from);
  }
  if (to) {
    whereSql += " AND ts <= ?";
    whereParams.push(to);
  }

  // Fetch raw rows in chunks, group, collect until we have enough
  let allGrouped = [];
  let exhausted = false;
  let lastRawId = before_id ? Number(before_id) : null;
  let attempts = 0;
  const CHUNK = wantedLimit * 15;

  while (allGrouped.length < wantedLimit && !exhausted && attempts < 10) {
    let sql;
    const params = [];

    if (lastRawId) {
      sql = `SELECT id, ts, host, app, level, message FROM logs WHERE id < ?`;
      params.push(lastRawId);
    } else {
      sql = `SELECT id, ts, host, app, level, message FROM logs WHERE 1=1`;
    }

    // Add filters (skip before_id since handled above)
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

    sql += " ORDER BY id DESC LIMIT ?";
    params.push(CHUNK);

    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    lastRawId = rows[rows.length - 1].id;
    const grouped = groupLogs(rows);
    allGrouped.push(...grouped);
    attempts++;

    if (rows.length < CHUNK) exhausted = true;
  }

  const trimmed = allGrouped.slice(0, wantedLimit);
  // Cursor for next page = lowest raw ID we consumed
  const nextCursor = lastRawId;

  return {
    logs: trimmed,
    count: trimmed.length,
    hasMore: !exhausted || allGrouped.length > wantedLimit,
    nextCursor,
  };
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
