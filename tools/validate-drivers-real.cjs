/**
 * Real-data validation for the declarative driver layer.
 *
 * Unit tests only prove the drivers can parse synthetic fixtures. This proves
 * they handle REAL app data: for every source present on this machine it runs
 * the hand-written adapter and a declarative spec side by side and compares
 * session coverage and message counts.
 *
 * Read-only. Run: node tools/validate-drivers-real.cjs
 */
"use strict";

const path = require("node:path");
const os = require("node:os");
const registry = require("../lib/registry");
const { makeDeclarativeSource } = require("../lib/sources/declarative");

const home = os.homedir();

/** Declarative specs mirroring each real app's on-disk format. */
const SPECS = [
  {
    builtin: "claude-code",
    label: "Claude Code",
    spec: {
      id: "claude-spec",
      label: "Claude Code (spec)",
      driver: "jsonl-transcript",
      root: path.join(home, ".claude", "projects"),
      recursive: true,
      // Only <project>/<session>.jsonl; deeper dirs (.timelines/...) hold
      // non-session data.
      maxDepth: 2,
      extension: ".jsonl",
      session: { idFrom: "filename", titleFrom: "firstUser", projectFrom: "parentDir", fallbackProject: "Claude Code" },
      entry: {
        // Only conversation lines; .timelines/ and other sidecar records are
        // not part of the transcript.
        match: { path: "type", in: ["user", "assistant"] },
        skipTypePath: "isSidechain",
        skipTypes: [true],
        rolePath: "message.role",
        // content is a plain string in older entries and a block array in newer ones
        content: { blocks: { path: "message.content", typeField: "type", types: ["text"], textField: "text" } },
        tsPath: "timestamp",
        // Claude injects synthetic user lines (caveats, reminders) as XML.
        drop: { startsWith: ["<"], roles: ["user"] },
        // tool_use blocks in an assistant message are answered by tool_result
        // blocks in a later user message.
        toolCall: {
          callBlocks: {
            path: "message.content",
            typeField: "type",
            type: "tool_use",
            idPath: "id",
            namePath: "name",
            argsPath: "input",
            roles: ["assistant"],
          },
          resultBlocks: {
            path: "message.content",
            typeField: "type",
            type: "tool_result",
            idPath: "tool_use_id",
            resultPath: "content",
            statusPath: "is_error",
            roles: ["user"],
          },
        },
      },
    },
  },
  {
    builtin: "codex",
    label: "Codex",
    spec: {
      id: "codex-spec",
      label: "Codex (spec)",
      driver: "jsonl-transcript",
      root: path.join(home, ".codex", "sessions"),
      recursive: true,
      extension: ".jsonl",
      // Codex keeps every rollout verbatim; three of them here exceed the
      // driver's 32 MiB per-file default, which is a budget knob rather than
      // a parsing difference — raise it to show they are reachable.
      maxBytes: 128 * 1024 * 1024,
      // New format carries the id in payload.id, the old bare header in id.
      // Only session_meta holds the *session* id — every response_item has an
      // id of its own.
      session: {
        idFrom: { first: [{ path: "payload.id" }, { path: "id" }] },
        idFromEntry: { path: "type", in: ["session_meta"] },
        titleFrom: "firstUser",
        projectFrom: "parentDir",
        fallbackProject: "Codex",
      },
      entry: {
        // New format wraps items in {timestamp, type, payload}; the old one
        // writes them bare. unwrapPath handles both with one set of paths.
        unwrapPath: "payload",
        rolePath: "role",
        roleMap: { user: "user", assistant: "assistant", system: "assistant", developer: "assistant" },
        content: {
          blocks: {
            path: "content",
            typeField: "type",
            types: ["input_text", "output_text", "text"],
            textField: "text",
          },
        },
        tsPath: "timestamp",
        // Codex prepends synthetic user messages (repo instructions, env).
        drop: { startsWith: ["<", "# AGENTS.md", "You are Codex"], roles: ["user"] },
        toolCall: {
          call: {
            typePath: "type",
            types: ["function_call"],
            idPath: "call_id",
            namePath: "name",
            argsPath: "arguments",
            argsJson: true,
          },
          result: {
            typePath: "type",
            types: ["function_call_output"],
            idPath: "call_id",
            resultPath: "output",
            // codex.js keeps whatever the tool returned verbatim: a string
            // as-is, anything else JSON-stringified. It never scans the
            // payload for text blocks the way the other adapters do.
            resultFormat: "json",
          },
        },
      },
    },
  },
  {
    builtin: "workbuddy",
    label: "WorkBuddy",
    spec: {
      id: "workbuddy-spec",
      label: "WorkBuddy (spec)",
      driver: "jsonl-transcript",
      root: path.join(home, ".workbuddy", "projects"),
      recursive: true,
      maxDepth: 2,
      extension: ".jsonl",
      session: { idFrom: "filename", titleFrom: "firstUser", projectFrom: "parentDir", fallbackProject: "WorkBuddy" },
      entry: {
        // conversation lines plus the two tool event kinds
        match: { path: "type", in: ["message", "function_call", "function_call_result"] },
        rolePath: "role",
        content: { blocks: { path: "content", typeField: "type", types: ["input_text", "output_text", "text"], textField: "text" } },
        tsPath: "timestamp",
        tsUnit: "ms",
        toolCall: {
          call: {
            typePath: "type",
            types: ["function_call"],
            idPath: "callId",
            namePath: "name",
            argsPath: "arguments",
            argsJson: true,
          },
          result: {
            typePath: "type",
            types: ["function_call_result"],
            idPath: "callId",
            namePath: "name",
            resultPath: "output",
            statusPath: "status",
            // Large outputs are truncated to a pointer on disk; the built-in
            // adapter reads the real output back.
            follow: { marker: "Full output saved to:", maxBytes: 4 * 1024 * 1024 },
          },
        },
        // WorkBuddy wraps injected context (and the real query) in tags.
        textOps: [
          {
            op: "stripXmlBlocks",
            tags: ["system-reminder", "cb_summary", "conversation_history_summary"],
            roles: ["user"],
          },
          { op: "extractXmlTag", tag: "user_query", roles: ["user"] },
        ],
      },
    },
  },
  {
    builtin: "zcode",
    label: "ZCode",
    spec: {
      id: "zcode-spec",
      label: "ZCode (spec)",
      driver: "sqlite-session",
      db: path.join(home, ".zcode", "cli", "db", "db.sqlite"),
      tsUnit: "ms",
      session: {
        table: "session",
        idCol: "id",
        titleCol: "title",
        pathCol: "directory",
        createdCol: "time_created",
        updatedCol: "time_updated",
        // The built-in ZCode adapter skips subagent child sessions.
        exclude: [{ col: "task_type", equals: "subagent_child" }],
      },
      message: { table: "message", idCol: "id", sessionIdCol: "session_id", createdCol: "time_created", dataCol: "data", rolePath: "role", tsPath: "time.created" },
      part: { table: "part", messageIdCol: "message_id", sessionIdCol: "session_id", createdCol: "time_created", dataCol: "data", textTypes: ["text"], toolType: "tool" },
    },
  },
  {
    builtin: "opencode",
    label: "OpenCode",
    spec: {
      id: "opencode-spec",
      label: "OpenCode (spec)",
      driver: "sqlite-session",
      db: path.join(home, ".local", "share", "opencode", "opencode.db"),
      tsUnit: "ms",
      session: { table: "session", idCol: "id", titleCol: "title", pathCol: "directory", createdCol: "time_created", updatedCol: "time_updated" },
      message: { table: "message", idCol: "id", sessionIdCol: "session_id", createdCol: "time_created", dataCol: "data", rolePath: "role", tsPath: "time.created" },
      part: { table: "part", messageIdCol: "message_id", sessionIdCol: "session_id", createdCol: "time_created", dataCol: "data", textTypes: ["text"], toolType: "tool" },
    },
  },
];

/**
 * Key by id *and* file.
 *
 * Codex writes one rollout file per resume, so a session id legitimately maps
 * to several files; keying on the id alone would silently compare two
 * different files and report a difference that does not exist. For sqlite
 * sources filePath is the (constant) db path, so this degrades to the id.
 */
const byId = (rows) =>
  new Map(rows.map((r) => [`${String(r.externalId)}|${String(r.filePath ?? "")}`, r]));

const SHOW_DIFF = process.argv.includes("--diff");
const DIFF_SAMPLE = 5;
// Converting is the expensive half (it re-reads whole transcripts), so by
// default only the first few shared sessions are compared. SAMPLE=50 widens it
// when a claim needs more evidence than a handful of files.
const SAMPLE = Number(process.env.SAMPLE) > 0 ? Number(process.env.SAMPLE) : 5;

/** role order only — robust against formatting differences inside a message */
const sigRoles = (msgs) => (msgs ?? []).map((m) => m.role).join(",");

/** role + normalised text: whitespace-trimmed, capped so output stays readable */
const sigFull = (msgs) =>
  (msgs ?? [])
    .map((m) => `${m.role}:${String(m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`)
    .join("\n");

/** First index where two message lists diverge, for eyeballing a failure. */
function describeDiff(id, a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return `${id} @${i}: one side ended (ref=${a.length} spec=${b.length})`;
    if (x.role !== y.role || String(x.content ?? "") !== String(y.content ?? "")) {
      return (
        `${id} @${i}\n` +
        `    ref  ${x.role}: ${String(x.content ?? "").replace(/\s+/g, " ").slice(0, 120)}\n` +
        `    spec ${y.role}: ${String(y.content ?? "").replace(/\s+/g, " ").slice(0, 120)}`
      );
    }
  }
  return null;
}

async function main() {
  console.log("Real-data validation: declarative specs vs built-in adapters\n");
  const results = [];

  for (const { builtin, label, spec } of SPECS) {
    const reference = registry.getAdapter(builtin);
    if (!reference) {
      results.push({ label, status: "SKIP", detail: "built-in adapter missing" });
      continue;
    }

    const declarative = makeDeclarativeSource(spec);
    const t0 = Date.now();
    let refRows = [];
    let specRows = [];
    let err = null;
    try {
      refRows = (await reference.scan()) ?? [];
      specRows = (await declarative.scan()) ?? [];
    } catch (e) {
      err = e && e.message;
    }
    const ms = Date.now() - t0;

    if (err) {
      results.push({ label, status: "ERROR", detail: err });
      continue;
    }

    const refMap = byId(refRows);
    const specMap = byId(specRows);
    // Duplicate externalIds collapse in byId(); they mean two files claim the
    // same session, which is worth seeing rather than hiding.
    const refDup = refRows.length - refMap.size;
    const specDup = specRows.length - specMap.size;
    const shared = [...specMap.keys()].filter((k) => refMap.has(k));
    let countMatch = 0;
    for (const k of shared) {
      if (Number(refMap.get(k).messageCount) === Number(specMap.get(k).messageCount)) countMatch++;
    }
    const coverage = refMap.size ? shared.length / refMap.size : 0;
    const parity = shared.length ? countMatch / shared.length : 0;

    // Scan-time `messageCount` is not comparable everywhere: codex.js never
    // increments it (always 0) and claude.js counts raw transcript lines
    // rather than imported messages. The real semantic check is the converted
    // conversation: same length, same role order, same text.
    let convChecked = 0;
    let convMatch = 0;
    let roleMatch = 0;
    let fullMatch = 0;
    let firstDiff = null;
    for (const k of shared.slice(0, SAMPLE)) {
      try {
        const a = await reference.convert(refMap.get(k));
        const b = await declarative.convert(specMap.get(k));
        const am = a?.messages ?? [];
        const bm = b?.messages ?? [];
        convChecked++;
        if (am.length === bm.length) convMatch++;
        if (sigRoles(am) === sigRoles(bm)) roleMatch++;
        if (sigFull(am) === sigFull(bm)) fullMatch++;
        else if (!firstDiff) firstDiff = describeDiff(k, am, bm);
      } catch {
        /* a session either side cannot convert is not counted */
      }
    }
    const convParity = convChecked ? convMatch / convChecked : 0;

    // Session-set differences: a session only one side sees is a session the
    // user cannot import, so it is worth more than a column of percentages.
    let onlyRef = [];
    let onlySpec = [];
    if (SHOW_DIFF) {
      onlyRef = [...refMap.keys()].filter((k) => !specMap.has(k)).slice(0, DIFF_SAMPLE);
      onlySpec = [...specMap.keys()].filter((k) => !refMap.has(k)).slice(0, DIFF_SAMPLE);
      for (const k of onlyRef) {
        console.log(`  [only built-in] ${label} ${k} :: ${refMap.get(k).title}`);
      }
      for (const k of onlySpec) {
        console.log(`  [only spec]     ${label} ${k} :: ${specMap.get(k).title}`);
      }
    }

    results.push({
      label,
      status: refRows.length === 0 ? "NO DATA" : parity >= 0.95 && coverage >= 0.95 ? "PASS" : "DIFF",
      builtin: refRows.length,
      spec: specRows.length,
      dup: `${refDup}/${specDup}`,
      matched: shared.length,
      countMatch,
      coverage: `${(coverage * 100).toFixed(1)}%`,
      parity: `${(parity * 100).toFixed(1)}%`,
      conv: `${convMatch}/${convChecked}`,
      convParity,
      roles: `${roleMatch}/${convChecked}`,
      full: `${fullMatch}/${convChecked}`,
      firstDiff,
      ms,
    });
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad("source", 14) +
      pad("status", 9) +
      pad("built-in", 10) +
      pad("spec", 8) +
      pad("dup r/s", 9) +
      pad("matched", 9) +
      pad("msgCount=", 11) +
      pad("parity", 9) +
      pad("conv", 8) +
      pad("roles", 8) +
      pad("exact", 8) +
      "ms",
  );
  console.log("-".repeat(92));
  for (const r of results) {
    if (r.status === "SKIP" || r.status === "ERROR") {
      console.log(`${pad(r.label, 14)}${pad(r.status, 9)}${r.detail ?? ""}`);
      continue;
    }
    if (r.status === "NO DATA") {
      console.log(`${pad(r.label, 14)}${pad("NO DATA", 9)}(nothing on this machine — spec untested)`);
      continue;
    }
    console.log(
      `${pad(r.label, 14)}${pad(r.status, 9)}${pad(r.builtin, 10)}${pad(r.spec, 8)}${pad(r.dup, 9)}${pad(r.matched, 9)}${pad(r.countMatch, 11)}${pad(r.parity, 9)}${pad(r.conv, 8)}${pad(r.roles, 8)}${pad(r.full, 8)}${r.ms}`,
    );
  }
  console.log("\ncoverage = spec sessions that also exist in the built-in scan");
  console.log("parity   = share of matched sessions whose scan messageCount is identical (0% is expected for Codex: the built-in never fills it)");
  console.log(`conv     = ${SAMPLE} matched sessions: same message count / same role order / byte-identical text`);
  for (const r of results) {
    if (r.full && r.full !== "0/0" && !r.full.startsWith(`${r.full.split("/")[1]}/`)) {
      console.log(`\nfirst divergence — ${r.label}:\n  ${r.firstDiff}`);
    }
  }
}

main().catch((e) => {
  console.error("harness failed:", e);
  process.exit(1);
});
