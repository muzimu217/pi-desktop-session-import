/**
 * Codex adapter: reads Codex Desktop & CLI sessions under ~/.codex.
 *
 * Handles:
 * - Both uncompressed (.jsonl) and Zstandard-compressed (.jsonl.zst) rollouts
 * - Both active (~/.codex/sessions) and archived (~/.codex/archived_sessions) trees
 * - Paginated multi-segment threads (rollout-<ts>-<threadId>[_<pageId>].jsonl[.zst])
 * - Project & workspace mappings from .codex-global-state.json + state_5.sqlite
 * - Real thread titles from state_5.sqlite / session_index.jsonl
 * - Filtering internal subagent child spawns
 * - Both function_call and custom_tool_call items, excluding developer prompts
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const fsp = fs.promises;
const { createReadStream } = fs;
const zlib = require("node:zlib");
const readline = require("node:readline");
const { toIso, truncateTitle, projectNameOf, mapValuesWithConcurrency } = require("../util");

const SOURCE = "codex";
const SCAN_CONCURRENCY = 12;
const SCAN_HEAD_ITEMS = 60;
const LARGE_LINE_THRESHOLD = 256 * 1024;
const CONTRACT_SAFE_MESSAGES_MAX = 1980;

const ROLLOUT_RE =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\.jsonl(?:\.zst)?$/i;

const BASE64_DATA_URI_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g;

const codexHomeFor = (home = os.homedir()) =>
  process.env.CODEX_HOME && home === os.homedir()
    ? process.env.CODEX_HOME
    : path.join(home, ".codex");

const sessionsDirFor = (home = os.homedir()) => path.join(codexHomeFor(home), "sessions");

function cleanHostPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;
  let s = rawPath.trim();
  if (!s) return null;
  if (s.startsWith("\\\\?\\UNC\\")) {
    s = "\\\\" + s.slice(8);
  } else if (s.startsWith("\\\\?\\")) {
    s = s.slice(4);
  }
  if (s.length > 3) {
    s = s.replace(/[\\/]+$/, "");
  }
  return s || null;
}

function isCodexScratchCwd(rawPath) {
  const clean = cleanHostPath(rawPath);
  if (!clean) return true;
  const norm = clean.replace(/\//g, "\\").toLowerCase();
  return (
    norm.includes("\\documents\\codex\\") ||
    norm.endsWith("\\documents\\codex") ||
    norm.endsWith("\\.codex") ||
    norm.includes("\\.codex\\tmp") ||
    norm.includes("\\.codex\\.tmp")
  );
}

function isSubagentSource(sourceVal, threadSourceVal) {
  if (threadSourceVal === "subagent") return true;
  if (!sourceVal) return false;
  if (typeof sourceVal === "object") {
    return Boolean(sourceVal.subagent);
  }
  const s = String(sourceVal);
  return s === "subagent" || s.includes('"subagent"');
}

const SYNTHETIC_USER_PREFIXES = [
  "<",
  "# AGENTS.md",
  "# Context from my IDE setup",
  "# In app browser:",
  "# Browser comments:",
  "# Files mentioned by the user:",
  "# Diff comments:",
  "# Selected text:",
  "# Review findings:",
  "You are Codex",
];

const EXTRA_SYNTHETIC_PROMPTS = [
  "Respond to the user input in the context of our conversation.",
];

function isSyntheticUserText(text) {
  if (!text || typeof text !== "string") return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  return (
    SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ||
    EXTRA_SYNTHETIC_PROMPTS.some((exact) => trimmed === exact)
  );
}

function stripLeadingContextBlocks(text) {
  let s = String(text ?? "").trim();
  s = s.replace(/^<in-app-browser-context\b[\s\S]*?<\/in-app-browser-context>\s*/gi, "");
  return s.trim();
}

function parseUserAttachmentWrapper(rawText) {
  let text = stripLeadingContextBlocks(rawText);
  const files = [];
  if (text.startsWith("# Files mentioned by the user:")) {
    const marker = "## My request:";
    const idx = text.indexOf(marker);
    if (idx !== -1) {
      const headerBlock = text.slice(0, idx);
      for (const line of headerBlock.split(/\r?\n/)) {
        const m = line.match(/^##\s+([^:\r\n]+):/);
        if (m && m[1]) files.push(m[1].trim());
      }
      text = text.slice(idx + marker.length).trim();
    }
  }
  const hadImageTag = /<image\b/i.test(text);
  text = text
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "")
    .replace(/<image\b[^>]*\/?>/gi, "")
    .trim();
  return { text, files, hadImageTag };
}

function cleanPromptTitle(rawText) {
  if (!rawText) return "";
  const { text, files, hadImageTag } = parseUserAttachmentWrapper(rawText);
  if (text) return text.replace(/\s+/g, " ").trim();
  if (files.length > 0) return `[附件] ${files.join(", ")}`;
  if (hadImageTag) return "[图片消息]";
  return "";
}

function formatQuestionReplyBlock(rawText) {
  const m = String(rawText ?? "")
    .trim()
    .match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/i);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr) || arr.length === 0) return m[1].trim();
    return arr
      .map((item) => {
        const q = String(item?.question ?? "").trim();
        const a = String(item?.answer ?? "").trim();
        return q ? `> ${q}\n${a}` : a;
      })
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return m[1].trim();
  }
}

function cleanUserMessageText(rawText) {
  const qReply = formatQuestionReplyBlock(rawText);
  if (qReply !== null) return qReply;
  const { text, files, hadImageTag } = parseUserAttachmentWrapper(rawText);
  if (files.length > 0 && text) {
    return `[附件: ${files.join(", ")}]\n\n${text}`;
  }
  if (text) return text;
  if (files.length > 0) return `[附件: ${files.join(", ")}]`;
  if (hadImageTag) return "[图片附件]";
  return "";
}

function extractContentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (
      (c.type === "input_text" || c.type === "output_text" || c.type === "text") &&
      typeof c.text === "string"
    ) {
      parts.push(c.text);
    } else if (c.type === "input_image" || c.type === "image_url") {
      parts.push("[image]");
    }
  }
  return parts.join("\n").trim();
}

function formatToolOutput(output) {
  if (output == null) return "";
  if (typeof output === "string") {
    return output.length > LARGE_LINE_THRESHOLD
      ? output.replace(BASE64_DATA_URI_RE, "[image-omitted]")
      : output;
  }
  if (Array.isArray(output)) {
    const parts = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.text === "string") {
        parts.push(item.text);
      } else if (item.type === "input_image" || item.type === "image_url") {
        parts.push("[image]");
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join("");
  }
  const s = JSON.stringify(output) ?? "";
  return s.length > LARGE_LINE_THRESHOLD ? s.replace(BASE64_DATA_URI_RE, "[image-omitted]") : s;
}

function sanitizeLargeJsonLine(line) {
  if (line.length <= LARGE_LINE_THRESHOLD) return line;
  if (
    !line.includes('"response_item"') &&
    !line.includes('"session_meta"') &&
    !line.includes('"turn_context"') &&
    !line.includes('"message"') &&
    !line.includes('"function_call"') &&
    !line.includes('"custom_tool_call"')
  ) {
    return "";
  }
  if (line.includes("data:image/")) {
    return line.replace(BASE64_DATA_URI_RE, "[image-omitted]");
  }
  return line;
}

async function streamRolloutLines(filePath, onLine, shouldStop) {
  const rawStream = createReadStream(filePath);
  let input = rawStream;
  let zstdStream = null;
  if (filePath.endsWith(".zst")) {
    if (typeof zlib.createZstdDecompress !== "function") {
      rawStream.destroy();
      return { lines: 0, items: 0 };
    }
    zstdStream = zlib.createZstdDecompress();
    rawStream.on("error", (err) => zstdStream.destroy(err));
    input = rawStream.pipe(zstdStream);
  }
  input.setEncoding("utf8");
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const counter = { lines: 0, items: 0 };
  try {
    for await (const rawLine of rl) {
      counter.lines += 1;
      const candidate = sanitizeLargeJsonLine(rawLine);
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      onLine(parsed, counter);
      if (shouldStop && shouldStop(counter)) break;
    }
  } finally {
    rl.close();
    if (zstdStream) zstdStream.destroy();
    rawStream.destroy();
  }
  return counter;
}

function openReadOnlySqlite(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

async function loadCodexMetadata(codexHome) {
  const meta = {
    localProjects: new Map(),
    dbProjects: new Map(),
    threadAssignments: new Map(),
    indexNames: new Map(),
    dbThreads: new Map(),
    subagentIds: new Set(),
    historyStats: new Map(),
  };

  const globalStatePath = path.join(codexHome, ".codex-global-state.json");
  try {
    if (fs.existsSync(globalStatePath)) {
      const gs = JSON.parse(await fsp.readFile(globalStatePath, "utf8"));
      const lp = gs?.["local-projects"];
      if (lp && typeof lp === "object") {
        for (const [pid, p] of Object.entries(lp)) {
          if (!p || typeof p !== "object") continue;
          const roots = Array.isArray(p.rootPaths)
            ? p.rootPaths.map(cleanHostPath).filter(Boolean)
            : [];
          meta.localProjects.set(pid, { name: String(p.name || "").trim() || null, rootPaths: roots });
        }
      }
      const tpa = gs?.["thread-project-assignments"];
      if (tpa && typeof tpa === "object") {
        for (const [tid, asgn] of Object.entries(tpa)) {
          if (asgn && typeof asgn.projectId === "string") {
            meta.threadAssignments.set(tid, asgn.projectId);
          }
        }
      }
    }
  } catch {
    // Ignore malformed global state
  }

  const sessionIndexPath = path.join(codexHome, "session_index.jsonl");
  try {
    if (fs.existsSync(sessionIndexPath)) {
      const rawIdx = await fsp.readFile(sessionIndexPath, "utf8");
      for (const line of rawIdx.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj?.id && typeof obj.thread_name === "string" && obj.thread_name.trim()) {
            meta.indexNames.set(obj.id, obj.thread_name.trim());
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // optional file
  }

  let statePath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(statePath)) {
    try {
      const candidates = (await fsp.readdir(codexHome))
        .filter((f) => /^state_\d+\.sqlite$/i.test(f))
        .sort();
      if (candidates.length > 0) {
        statePath = path.join(codexHome, candidates[candidates.length - 1]);
      }
    } catch {
      // ignore
    }
  }
  const sdb = openReadOnlySqlite(statePath);
  if (sdb) {
    try {
      const tables = new Set(
        sdb
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name),
      );
      if (tables.has("projects")) {
        const rootsByProj = new Map();
        if (tables.has("project_roots")) {
          for (const r of sdb.prepare("SELECT project_id, path FROM project_roots ORDER BY position").all()) {
            const cp = cleanHostPath(r.path);
            if (!cp) continue;
            if (!rootsByProj.has(r.project_id)) rootsByProj.set(r.project_id, []);
            rootsByProj.get(r.project_id).push(cp);
          }
        }
        for (const p of sdb.prepare("SELECT id, name FROM projects").all()) {
          meta.dbProjects.set(p.id, {
            name: String(p.name || "").trim() || null,
            rootPaths: rootsByProj.get(p.id) || [],
          });
        }
      }
      if (tables.has("thread_spawn_edges")) {
        for (const edge of sdb.prepare("SELECT child_thread_id FROM thread_spawn_edges").all()) {
          if (edge.child_thread_id) meta.subagentIds.add(edge.child_thread_id);
        }
      }
      if (tables.has("threads")) {
        const availableCols = new Set(
          sdb
            .prepare("PRAGMA table_info(threads)")
            .all()
            .map((r) => r.name),
        );
        const wanted = [
          "id",
          "rollout_path",
          "created_at",
          "updated_at",
          "created_at_ms",
          "updated_at_ms",
          "source",
          "thread_source",
          "cwd",
          "title",
          "first_user_message",
          "name",
          "model",
          "model_provider",
          "archived",
          "project_id",
          "attached_thread_parent_id",
        ].filter((c) => availableCols.has(c));
        if (wanted.includes("id")) {
          const rows = sdb.prepare(`SELECT ${wanted.join(", ")} FROM threads`).all();
          for (const row of rows) {
            if (!row.id) continue;
            if (
              row.attached_thread_parent_id ||
              isSubagentSource(row.source, row.thread_source)
            ) {
              meta.subagentIds.add(row.id);
            }
            meta.dbThreads.set(row.id, row);
          }
        }
      }
    } catch {
      // gracefully degrade
    } finally {
      try {
        sdb.close();
      } catch {
        // ignore
      }
    }
  }

  const histPath = path.join(codexHome, "thread_history_1.sqlite");
  const hdb = openReadOnlySqlite(histPath);
  if (hdb) {
    try {
      const rows = hdb
        .prepare(
          `SELECT thread_id,
                  COUNT(*) AS item_count,
                  MAX(created_at_ms) AS max_ts_ms
           FROM thread_items
           WHERE item_type IN ('userMessage', 'agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch')
           GROUP BY thread_id`,
        )
        .all();
      for (const r of rows) {
        if (r.thread_id) {
          meta.historyStats.set(r.thread_id, {
            count: Number(r.item_count) || 0,
            maxTsMs: Number(r.max_ts_ms) || 0,
          });
        }
      }
    } catch {
      // optional
    } finally {
      try {
        hdb.close();
      } catch {
        // ignore
      }
    }
  }

  return meta;
}

async function collectRollouts(codexHome) {
  const dirs = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const rawFiles = [];

  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) await walk(full, depth + 1);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))
      ) {
        rawFiles.push(full);
      }
    }
  };

  for (const d of dirs) {
    await walk(d, 0);
  }

  const stated = await mapValuesWithConcurrency(rawFiles, SCAN_CONCURRENCY, async (filePath) => {
    try {
      const info = await fsp.stat(filePath);
      if (!info.isFile() || info.size === 0) return null;
      return { filePath, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  });

  const byThread = new Map();
  for (const item of stated.filter(Boolean)) {
    const base = path.basename(item.filePath);
    const stem = base.endsWith(".zst") ? base.slice(0, -4) : base;
    const m = ROLLOUT_RE.exec(base);
    const threadId = m ? m[2] : stem.replace(/\.jsonl$/i, "");
    const segmentId = m ? m[3] || null : null;
    const stamp = m ? m[1] : "";

    if (!byThread.has(threadId)) {
      byThread.set(threadId, new Map());
    }
    const segMap = byThread.get(threadId);
    const existing = segMap.get(stem);
    if (!existing || (existing.filePath.endsWith(".zst") && !item.filePath.endsWith(".zst"))) {
      segMap.set(stem, {
        ...item,
        threadId,
        segmentId,
        stamp,
      });
    }
  }

  const groups = [];
  for (const [threadId, segMap] of byThread.entries()) {
    const segments = [...segMap.values()].sort((a, b) => {
      if (a.stamp !== b.stamp) return a.stamp < b.stamp ? -1 : 1;
      if (!a.segmentId && b.segmentId) return -1;
      if (a.segmentId && !b.segmentId) return 1;
      return a.mtimeMs - b.mtimeMs;
    });
    groups.push({ threadId, segments });
  }
  return groups;
}

function resolveProjectInfo(threadId, candidateCwds, meta) {
  const assignedProjId = meta.threadAssignments.get(threadId);
  if (assignedProjId && meta.localProjects.has(assignedProjId)) {
    const lp = meta.localProjects.get(assignedProjId);
    const rootPath = lp.rootPaths[0] || null;
    return {
      projectName: lp.name || projectNameOf(rootPath) || "Codex",
      projectPath: rootPath,
    };
  }

  const dbRow = meta.dbThreads.get(threadId);
  if (dbRow?.project_id && meta.dbProjects.has(dbRow.project_id)) {
    const dp = meta.dbProjects.get(dbRow.project_id);
    const rootPath = dp.rootPaths[0] || null;
    return {
      projectName: dp.name || projectNameOf(rootPath) || "Codex",
      projectPath: rootPath,
    };
  }

  const allProjects = [...meta.localProjects.values(), ...meta.dbProjects.values()];
  for (const rawCwd of candidateCwds) {
    const cwd = cleanHostPath(rawCwd);
    if (!cwd || isCodexScratchCwd(cwd)) continue;
    const cwdLower = cwd.toLowerCase();
    for (const proj of allProjects) {
      for (const root of proj.rootPaths || []) {
        const rootLower = root.toLowerCase();
        if (
          cwdLower === rootLower ||
          cwdLower.startsWith(rootLower + "\\") ||
          cwdLower.startsWith(rootLower + "/")
        ) {
          return {
            projectName: proj.name || projectNameOf(root) || "Codex",
            projectPath: root,
          };
        }
      }
    }
    return {
      projectName: projectNameOf(cwd) || "Codex",
      projectPath: cwd,
    };
  }

  return {
    projectName: "Codex (独立会话)",
    projectPath: null,
  };
}

async function scanSegmentHead(filePath) {
  let externalId = "";
  let sessionCwd = null;
  let turnCwd = null;
  let startedAt = null;
  let lastAt = null;
  let firstUser = null;
  let model = null;
  let subagent = false;
  let messageCount = 0;

  try {
    await streamRolloutLines(
      filePath,
      (obj, counter) => {
        if (obj.type === "session_meta" && obj.payload) {
          externalId = obj.payload.id ?? externalId;
          sessionCwd = obj.payload.cwd ?? sessionCwd;
          startedAt = obj.payload.timestamp ?? obj.timestamp ?? startedAt;
          if (isSubagentSource(obj.payload.source, obj.payload.thread_source)) {
            subagent = true;
          }
          return;
        }
        if (obj.type === "turn_context" && obj.payload) {
          if (obj.payload.cwd && !isCodexScratchCwd(obj.payload.cwd)) {
            turnCwd = obj.payload.cwd;
          }
          if (obj.payload.model) model = obj.payload.model;
          return;
        }
        if (obj.type === "response_item" && obj.payload) {
          counter.items += 1;
          if (obj.timestamp) lastAt = obj.timestamp;
          const item = obj.payload;
          if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
            const text = extractContentText(item.content);
            if (item.role === "user") {
              if (!isSyntheticUserText(text)) {
                const cleaned = cleanPromptTitle(text);
                if (cleaned) {
                  if (!firstUser) firstUser = cleaned;
                  messageCount += 1;
                }
              }
            } else if (text) {
              messageCount += 1;
            }
          } else if (
            item.type === "function_call_output" ||
            item.type === "custom_tool_call_output"
          ) {
            messageCount += 1;
          }
          return;
        }
        if (!externalId && obj.id && obj.timestamp && !obj.type) {
          externalId = obj.id;
          startedAt = obj.timestamp;
          sessionCwd = obj.cwd ?? null;
          return;
        }
        if (
          obj.type === "message" ||
          obj.type === "function_call_output" ||
          obj.type === "custom_tool_call_output"
        ) {
          counter.items += 1;
          if (obj.timestamp) lastAt = obj.timestamp;
          if (obj.type === "message" && obj.role === "user") {
            const text = extractContentText(obj.content);
            if (!isSyntheticUserText(text)) {
              const cleaned = cleanPromptTitle(text);
              if (cleaned) {
                if (!firstUser) firstUser = cleaned;
                messageCount += 1;
              }
            }
          } else {
            messageCount += 1;
          }
        }
      },
      (counter) => subagent || (Boolean(firstUser) && counter.items >= SCAN_HEAD_ITEMS),
    );
  } catch {
    return null;
  }

  return {
    externalId,
    cwd: turnCwd || sessionCwd,
    startedAt,
    lastAt,
    firstUser,
    model,
    subagent,
    messageCount,
  };
}

function epochToIso(secOrMs, isMs) {
  const n = Number(secOrMs);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = isMs ? n : n < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function scan(home = os.homedir()) {
  const codexHome = codexHomeFor(home);
  const [meta, groups] = await Promise.all([
    loadCodexMetadata(codexHome),
    collectRollouts(codexHome),
  ]);

  if (groups.length === 0) return [];

  const results = await mapValuesWithConcurrency(groups, SCAN_CONCURRENCY, async (group) => {
    const { threadId, segments } = group;
    if (meta.subagentIds.has(threadId)) return null;

    const dbRow = meta.dbThreads.get(threadId) || null;
    const hist = meta.historyStats.get(threadId) || null;
    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];

    let head = null;
    const dbTitleCandidate =
      (typeof dbRow?.name === "string" && dbRow.name.trim()) ||
      meta.indexNames.get(threadId) ||
      cleanPromptTitle(dbRow?.first_user_message) ||
      cleanPromptTitle(dbRow?.title) ||
      "";

    if (!dbRow || !dbTitleCandidate || (!hist?.count && segments.length === 1)) {
      head = await scanSegmentHead(firstSeg.filePath);
      if (head?.subagent) return null;
      if (!dbTitleCandidate && !head?.firstUser && segments.length > 1) {
        head = await scanSegmentHead(lastSeg.filePath);
        if (head?.subagent) return null;
      }
    }

    const fullTitle = dbTitleCandidate || head?.firstUser || "";
    if (!fullTitle) return null;

    const candidateCwds = [dbRow?.cwd, head?.cwd].filter(Boolean);
    const { projectName, projectPath } = resolveProjectInfo(threadId, candidateCwds, meta);

    const createdAt =
      epochToIso(dbRow?.created_at_ms, true) ||
      epochToIso(dbRow?.created_at, false) ||
      (head?.startedAt ? toIso(head.startedAt) : null) ||
      toIso(firstSeg.mtimeMs);

    const updatedMsCandidates = [
      Number(dbRow?.updated_at_ms) || 0,
      dbRow?.updated_at ? (Number(dbRow.updated_at) < 1e11 ? Number(dbRow.updated_at) * 1000 : Number(dbRow.updated_at)) : 0,
      hist?.maxTsMs || 0,
      Math.floor(lastSeg.mtimeMs || 0),
    ].filter((v) => Number.isFinite(v) && v > 0);
    const updatedAt =
      updatedMsCandidates.length > 0
        ? toIso(Math.max(...updatedMsCandidates))
        : toIso(head?.lastAt, createdAt);

    let messageCount = hist?.count || head?.messageCount || 0;
    if (messageCount === 0) {
      const probe = head ?? (await scanSegmentHead(lastSeg.filePath));
      messageCount = Math.max(probe?.messageCount || 0, 1);
    }

    const filePaths = segments.map((s) => s.filePath);

    return {
      source: SOURCE,
      externalId: threadId,
      title: truncateTitle(fullTitle) || threadId,
      fullTitle,
      projectName,
      projectPath,
      modelId: dbRow?.model || head?.model || null,
      providerId: dbRow?.model_provider || null,
      createdAt,
      updatedAt: updatedAt < createdAt ? createdAt : updatedAt,
      messageCount,
      filePath: filePaths[filePaths.length - 1],
      filePaths,
    };
  });

  const sessions = results.filter(Boolean);
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return sessions;
}

async function scanFast(home = os.homedir()) {
  return scan(home);
}

function capMessagesPreservingDialogue(messages, limit) {
  if (messages.length <= limit) return messages;
  const dialogueIdx = [];
  const toolIdx = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === "tool") toolIdx.push(i);
    else dialogueIdx.push(i);
  }
  if (dialogueIdx.length >= limit) {
    const keepSet = new Set(dialogueIdx.slice(dialogueIdx.length - limit));
    return messages.filter((_, idx) => keepSet.has(idx));
  }
  const remainingForTools = limit - dialogueIdx.length;
  const keptTools = toolIdx.slice(Math.max(0, toolIdx.length - remainingForTools));
  const keepSet = new Set([...dialogueIdx, ...keptTools]);
  return messages.filter((_, idx) => keepSet.has(idx));
}

async function resolveSegmentPathsForSummary(summary) {
  if (Array.isArray(summary?.filePaths) && summary.filePaths.length > 0) {
    return summary.filePaths;
  }
  if (summary?.externalId) {
    const groups = await collectRollouts(codexHomeFor());
    const found = groups.find((g) => g.threadId === summary.externalId);
    if (found && found.segments.length > 0) {
      return found.segments.map((s) => s.filePath);
    }
  }
  return summary?.filePath ? [summary.filePath] : [];
}

async function convert(summary) {
  const filePaths = await resolveSegmentPathsForSummary(summary);
  const messages = [];
  const pendingCalls = new Map();
  const seenItemKeys = new Set();
  let latestTurnCwd = null;
  let latestModel = summary?.modelId ?? null;
  let earliestAt = summary?.createdAt ?? null;
  let latestAt = summary?.updatedAt ?? null;

  const processItem = (item, timestamp, ordinal) => {
    if (!item || typeof item !== "object") return;
    const dedupeKey =
      item.id ||
      (item.call_id && item.type ? `${item.type}:${item.call_id}` : null) ||
      (ordinal !== undefined ? `ord:${ordinal}:${item.type}` : null);
    if (dedupeKey) {
      if (seenItemKeys.has(dedupeKey)) return;
      seenItemKeys.add(dedupeKey);
    }

    const createdAt = toIso(timestamp, latestAt || earliestAt || new Date().toISOString());
    if (timestamp) {
      if (!earliestAt || createdAt < earliestAt) earliestAt = createdAt;
      if (!latestAt || createdAt > latestAt) latestAt = createdAt;
    }

    if (item.type === "message") {
      if (item.role !== "user" && item.role !== "assistant") return;
      const rawText = extractContentText(item.content);
      if (!rawText) return;
      if (item.role === "user") {
        if (isSyntheticUserText(rawText)) return;
        const text = cleanUserMessageText(rawText);
        if (!text) return;
        messages.push({
          role: "user",
          content: text,
          createdAt,
        });
      } else {
        messages.push({
          role: "assistant",
          content: rawText,
          createdAt,
        });
      }
      return;
    }

    if ((item.type === "function_call" || item.type === "custom_tool_call") && item.call_id) {
      let args;
      if (item.type === "custom_tool_call") {
        args = typeof item.input === "string" ? { input: item.input } : item.input;
      } else {
        try {
          args = JSON.parse(item.arguments ?? "");
        } catch {
          args = item.arguments;
        }
      }
      pendingCalls.set(item.call_id, {
        name: item.name ?? "tool",
        args,
        status: item.status,
      });
      return;
    }

    if (
      (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
      item.call_id
    ) {
      const pending = pendingCalls.get(item.call_id);
      pendingCalls.delete(item.call_id);
      const output = formatToolOutput(item.output);
      const isErr =
        pending?.status === "failed" ||
        pending?.status === "error" ||
        item.status === "failed";
      messages.push({
        role: "tool",
        content: output,
        createdAt,
        toolName: pending?.name ?? "tool",
        toolCallId: item.call_id,
        toolStatus: isErr ? "error" : "success",
        toolArgs: pending?.args,
        toolResult: output,
      });
    }
  };

  for (const fp of filePaths) {
    try {
      await streamRolloutLines(fp, (obj) => {
        if (obj.type === "session_meta" && obj.payload) {
          const ts = obj.payload.timestamp ?? obj.timestamp;
          if (ts) {
            const iso = toIso(ts);
            if (!earliestAt || iso < earliestAt) earliestAt = iso;
          }
          return;
        }
        if (obj.type === "turn_context" && obj.payload) {
          if (obj.payload.cwd && !isCodexScratchCwd(obj.payload.cwd)) {
            latestTurnCwd = cleanHostPath(obj.payload.cwd);
          }
          if (obj.payload.model) latestModel = obj.payload.model;
          return;
        }
        if (obj.type === "response_item" && obj.payload) {
          processItem(obj.payload, obj.timestamp ?? null, obj.ordinal);
          return;
        }
        if (
          obj.type === "message" ||
          obj.type === "function_call" ||
          obj.type === "function_call_output" ||
          obj.type === "custom_tool_call" ||
          obj.type === "custom_tool_call_output"
        ) {
          processItem(obj, obj.timestamp ?? null, obj.ordinal);
        }
      });
    } catch {
      // Continue remaining segments if one segment is unreadable.
    }
  }

  const finalMessages = capMessagesPreservingDialogue(messages, CONTRACT_SAFE_MESSAGES_MAX);
  const resolvedProjectPath =
    summary?.projectPath ??
    (latestTurnCwd && !isCodexScratchCwd(latestTurnCwd) ? latestTurnCwd : null);

  return {
    session: {
      id: `import-codex-${summary.externalId}`,
      title: summary.fullTitle || summary.title,
      projectPath: resolvedProjectPath,
      modelId: latestModel,
      providerId: summary.providerId ?? null,
      mode: "agent",
      createdAt: earliestAt || summary.createdAt,
      updatedAt: latestAt && earliestAt && latestAt < earliestAt ? earliestAt : latestAt || summary.updatedAt,
    },
    messages: finalMessages,
  };
}

module.exports = {
  source: SOURCE,
  label: "Codex",
  codexHomeFor,
  sessionsDirFor,
  scan,
  scanFast,
  convert,
  SYNTHETIC_USER_PREFIXES,
  isSyntheticUserText,
  cleanPromptTitle,
  cleanUserMessageText,
  formatQuestionReplyBlock,
};
