/**
 * OpenCode adapter: reads OpenCode v1.x's single SQLite database.
 *
 * OpenCode moved off the old per-file JSON tree (storage/session|message|part)
 * to one SQLite database. The on-disk schema is the same three-layer model as
 * ZCode — session -> message -> part, with each row's payload in a `data`
 * JSON column — so this adapter mirrors lib/sources/zcode.js but queries the
 * DB instead of walking directories.
 *
 * The database lives in different places per platform/install (#682):
 * the Windows app keeps it under %LOCALAPPDATA%\opencode\data\, everything
 * else (macOS, Linux, and Windows CLI installs that honour the Unix-style
 * layout) under the XDG data dir (~/.local/share/opencode by default).
 * Candidates are probed in that order; the first one that exists wins.
 *
 * Read-only via the built-in node:sqlite; never mutates the user's OpenCode data.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { toIso, truncateTitle, projectNameOf } = require("../util");

const SOURCE = "opencode";

function dbPathCandidates({ home = os.homedir(), env = process.env } = {}) {
  const out = [];
  // Windows app storage (confirmed by OpenCode's own tracker): %LOCALAPPDATA%\opencode\data.
  if (env.LOCALAPPDATA) {
    out.push(path.join(env.LOCALAPPDATA, "opencode", "data", "opencode.db"));
  }
  // XDG data dir first when set, then the ~/.local/share default — probing
  // both costs nothing and covers installs that ignore XDG.
  if (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)) {
    out.push(path.join(env.XDG_DATA_HOME, "opencode", "opencode.db"));
  }
  out.push(path.join(home, ".local", "share", "opencode", "opencode.db"));
  return out;
}

function resolveDbPath(options) {
  for (const candidate of dbPathCandidates(options)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable stat (permissions, exotic mounts): fall through to the next candidate.
    }
  }
  return null;
}

/** First candidate (legacy single-path shape); kept for compatibility. */
function dbPathFor(options) {
  return dbPathCandidates(options)[0];
}

function parseJsonColumn(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapToolStatus(status) {
  if (status === "error") return "error";
  if (status === "completed") return "success";
  return "running";
}

function openDb(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true });
}

async function scan() {
  const dbPath = resolveDbPath();
  if (!dbPath) {
    // DB absent (OpenCode never run / not installed) — nothing to import.
    return [];
  }
  let db;
  try {
    db = openDb(dbPath);
  } catch {
    // Present but unreadable (locked, corrupt, unsupported): report nothing
    // rather than half a source.
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT s.id, s.directory, s.title, s.time_created, s.time_updated,
                COALESCE(m.message_count, 0) AS message_count
         FROM session s
         LEFT JOIN (
           SELECT session_id, COUNT(*) AS message_count
           FROM message
           GROUP BY session_id
         ) m ON m.session_id = s.id
         WHERE m.message_count > 0`,
      )
      .all();
    const sessions = [];
    for (const row of rows) {
      if (!row.id) continue;
      sessions.push({
        source: SOURCE,
        externalId: row.id,
        title: truncateTitle(row.title) || row.id,
        fullTitle: String(row.title ?? ""),
        projectName: projectNameOf(row.directory) ?? "OpenCode",
        projectPath: row.directory ?? null,
        modelId: null,
        providerId: null,
        createdAt: toIso(row.time_created),
        updatedAt: toIso(row.time_updated, toIso(row.time_created)),
        messageCount: Number(row.message_count),
        filePath: dbPath,
      });
    }
    return sessions;
  } finally {
    db.close();
  }
}

async function convert(summary) {
  const db = openDb(summary.filePath || resolveDbPath() || dbPathFor());
  try {
    const messageRows = db
      .prepare(
        `SELECT id, time_created, data FROM message
         WHERE session_id = ?
         ORDER BY time_created, id`,
      )
      .all(summary.externalId);
    const partRows = db
      .prepare(
        `SELECT message_id, data FROM part
         WHERE session_id = ?
         ORDER BY time_created, id`,
      )
      .all(summary.externalId);

    const partsByMessage = new Map();
    for (const row of partRows) {
      const part = parseJsonColumn(row.data);
      if (!part?.type || !row.message_id) continue;
      const bucket = partsByMessage.get(row.message_id) ?? [];
      bucket.push(part);
      partsByMessage.set(row.message_id, bucket);
    }

    const messages = [];
    let modelId = null;
    let providerId = null;

    const flushText = (role, createdAt, texts) => {
      const text = texts.join("\n").trim();
      texts.length = 0;
      if (!text) return;
      messages.push({ role, content: text, createdAt });
    };

    for (const row of messageRows) {
      const msg = parseJsonColumn(row.data);
      if (!msg || !row.id) continue;
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const role = msg.role;
      const createdAt = toIso(msg.time?.created ?? row.time_created);
      if (role === "assistant") {
        modelId = msg.modelID ?? modelId;
        providerId = msg.providerID ?? providerId;
      }

      // Emit parts in stored order so tool calls keep their place.
      const texts = [];
      for (const part of partsByMessage.get(row.id) ?? []) {
        if (part.type === "text" && part.text && part.synthetic !== true) {
          texts.push(part.text);
        } else if (part.type === "tool") {
          flushText(role, createdAt, texts);
          const output = part.state?.output;
          const outputText =
            typeof output === "string" ? output : output ? JSON.stringify(output) : "";
          messages.push({
            role: "tool",
            content: outputText,
            toolName: part.tool ?? "tool",
            toolStatus: mapToolStatus(part.state?.status),
            toolArgs: part.state?.input ?? null,
            toolResult: outputText,
            createdAt,
          });
        }
      }
      flushText(role, createdAt, texts);
    }

    return {
      session: {
        id: `import-opencode-${summary.externalId}`,
        title: summary.fullTitle || summary.title,
        projectPath: summary.projectPath,
        modelId,
        providerId,
        mode: "agent",
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      },
      messages,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  source: SOURCE,
  label: "OpenCode",
  dbPathFor,
  dbPathCandidates,
  resolveDbPath,
  scan,
  convert,
};
