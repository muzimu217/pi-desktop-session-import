"use strict";
// Read-only reconnaissance of OpenCode 1.2.10's opencode.db schema.
const { DatabaseSync } = require("node:sqlite");
const dbPath = process.env.OPENCODE_DB || require("node:os").homedir() + "/.local/share/opencode/opencode.db";

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all();
  console.log("=== TABLES/VIEWS ===");
  for (const t of tables) {
    console.log(`- ${t.type}: ${t.name}`);
  }

  // Focus on likely session/message/part tables
  const candidates = tables.filter((t) =>
    /session|message|part|conversation|chat|prompt|completion|span|event/i.test(t.name),
  );
  for (const t of candidates) {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all();
    let count = 0;
    try { count = db.prepare(`SELECT COUNT(*) AS c FROM ${JSON.stringify(t.name)}`).get().c; } catch {}
    console.log(`\n=== ${t.name} (rows=${count}) ===`);
    for (const c of cols) {
      console.log(`  ${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PK" : ""}`);
    }
    // sample one row as JSON-ish
    try {
      const row = db.prepare(`SELECT * FROM ${JSON.stringify(t.name)} LIMIT 1`).get();
      if (row) {
        const slim = {};
        for (const [k, v] of Object.entries(row)) {
          let s = typeof v === "string" ? v : String(v);
          if (s.length > 200) s = s.slice(0, 200) + "…";
          slim[k] = s;
        }
        console.log("  SAMPLE:", JSON.stringify(slim));
      }
    } catch (e) {
      console.log("  (sample failed:", e.message, ")");
    }
  }
} finally {
  db.close();
}
