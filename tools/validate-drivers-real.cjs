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
        rolePath: "message.role",
        // content is a plain string in older entries and a block array in newer ones
        content: { blocks: { path: "message.content", typeField: "type", types: ["text"], textField: "text" } },
        tsPath: "timestamp",
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
      session: { idFrom: { path: "payload.id" }, titleFrom: "firstUser", projectFrom: "parentDir", fallbackProject: "Codex" },
      entry: {
        // Codex wraps everything in an event envelope
        rolePath: "payload.role",
        content: {
          blocks: {
            path: "payload.content",
            typeField: "type",
            types: ["input_text", "output_text", "text"],
            textField: "text",
          },
        },
        tsPath: "timestamp",
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
        rolePath: "role",
        content: { blocks: { path: "content", typeField: "type", types: ["input_text", "output_text", "text"], textField: "text" } },
        tsPath: "timestamp",
        tsUnit: "ms",
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

const byId = (rows) => new Map(rows.map((r) => [String(r.externalId), r]));

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
    const shared = [...specMap.keys()].filter((k) => refMap.has(k));
    let countMatch = 0;
    for (const k of shared) {
      if (Number(refMap.get(k).messageCount) === Number(specMap.get(k).messageCount)) countMatch++;
    }
    const coverage = refMap.size ? shared.length / refMap.size : 0;
    const parity = shared.length ? countMatch / shared.length : 0;

    // Scan-time `messageCount` is not comparable everywhere: codex.js counts
    // every response_item event and is explicitly a head-limited
    // approximation. The real semantic check is the converted conversation.
    let convChecked = 0;
    let convMatch = 0;
    for (const k of shared.slice(0, 5)) {
      try {
        const a = await reference.convert(refMap.get(k));
        const b = await declarative.convert(specMap.get(k));
        convChecked++;
        if ((a?.messages?.length ?? -1) === (b?.messages?.length ?? -1)) convMatch++;
      } catch {
        /* a session either side cannot convert is not counted */
      }
    }
    const convParity = convChecked ? convMatch / convChecked : 0;

    results.push({
      label,
      status: refRows.length === 0 ? "NO DATA" : parity >= 0.95 && coverage >= 0.95 ? "PASS" : "DIFF",
      builtin: refRows.length,
      spec: specRows.length,
      matched: shared.length,
      countMatch,
      coverage: `${(coverage * 100).toFixed(1)}%`,
      parity: `${(parity * 100).toFixed(1)}%`,
      conv: `${convMatch}/${convChecked}`,
      convParity,
      ms,
    });
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad("source", 14) +
      pad("status", 9) +
      pad("built-in", 10) +
      pad("spec", 8) +
      pad("matched", 9) +
      pad("msgCount=", 11) +
      pad("parity", 9) +
      pad("convert", 9) +
      "ms",
  );
  console.log("-".repeat(88));
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
      `${pad(r.label, 14)}${pad(r.status, 9)}${pad(r.builtin, 10)}${pad(r.spec, 8)}${pad(r.matched, 9)}${pad(r.countMatch, 11)}${pad(r.parity, 9)}${pad(r.conv, 9)}${r.ms}`,
    );
  }
  console.log("\ncoverage = spec sessions that also exist in the built-in scan");
  console.log("parity   = share of matched sessions whose messageCount is identical");
}

main().catch((e) => {
  console.error("harness failed:", e);
  process.exit(1);
});
