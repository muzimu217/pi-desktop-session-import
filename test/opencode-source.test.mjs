// OpenCode adapter tests (#682): candidate path resolution per platform and
// scan/convert against a real temporary SQLite database in the v1.x shape.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adapter = require("../lib/sources/opencode.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-adapter-"));
}

/** Minimal v1.x database: one session, one user text, one assistant text+tool. */
function buildDb(dir, { sessionTitle = "Adapter test session", directory = "/tmp/proj" } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
    share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    summary_diffs TEXT, revert TEXT, permission TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    time_compacting INTEGER, time_archived INTEGER)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
    session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    data TEXT NOT NULL)`);

  const t0 = 1770000000000;
  db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)")
    .run("ses_test1", "proj1", "slug", directory, sessionTitle, "1.2.10", t0, t0 + 5000);

  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
    .run("msg_u1", "ses_test1", t0 + 100, t0 + 100,
      JSON.stringify({ role: "user", time: { created: t0 + 100 } }));
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)")
    .run("p1", "msg_u1", "ses_test1", t0 + 101, t0 + 101, JSON.stringify({ type: "text", text: "hello opencode" }));

  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
    .run("msg_a1", "ses_test1", t0 + 200, t0 + 200,
      JSON.stringify({ role: "assistant", time: { created: t0 + 200, completed: t0 + 300 },
        modelID: "test-model", providerID: "opencode" }));
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)")
    .run("p2", "msg_a1", "ses_test1", t0 + 201, t0 + 201, JSON.stringify({ type: "text", text: "running it" }));
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)")
    .run("p3", "msg_a1", "ses_test1", t0 + 202, t0 + 202,
      JSON.stringify({ type: "tool", callID: "c1", tool: "bash",
        state: { status: "completed", input: { command: "pwd" }, output: "/tmp/proj" } }));
  db.close();
  return dbPath;
}

test("dbPathCandidates covers LOCALAPPDATA, XDG, and the unix default in order", () => {
  const home = "/home/tester";
  const candidates = adapter.dbPathCandidates({ home, env: { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local", XDG_DATA_HOME: "/xdg/data" } });
  assert.deepEqual(candidates, [
    path.join("C:\\Users\\t\\AppData\\Local", "opencode", "data", "opencode.db"),
    path.join("/xdg/data", "opencode", "opencode.db"),
    path.join(home, ".local", "share", "opencode", "opencode.db"),
  ]);
});

test("dbPathCandidates without LOCALAPPDATA/XDG falls back to ~/.local/share", () => {
  const candidates = adapter.dbPathCandidates({ home: "/home/tester", env: {} });
  assert.deepEqual(candidates, [path.join("/home/tester", ".local", "share", "opencode", "opencode.db")]);
});

test("resolveDbPath picks the first existing candidate (Windows layout wins when present)", () => {
  const home = tmpdir();
  const localAppData = tmpdir();
  const xdg = tmpdir();
  // Only the LOCALAPPDATA layout exists -> it must win over the other candidates.
  fs.mkdirSync(path.join(localAppData, "opencode", "data"), { recursive: true });
  const dbPath = path.join(localAppData, "opencode", "data", "opencode.db");
  fs.writeFileSync(dbPath, "placeholder");
  assert.equal(
    adapter.resolveDbPath({ home, env: { LOCALAPPDATA: localAppData, XDG_DATA_HOME: xdg } }),
    dbPath,
  );
  // Nothing exists anywhere -> null (source reports "not detected").
  fs.rmSync(dbPath);
  assert.equal(adapter.resolveDbPath({ home, env: { LOCALAPPDATA: localAppData, XDG_DATA_HOME: xdg } }), null);
});

test("resolveDbPath finds the XDG layout when the Windows layout is absent", () => {
  const home = tmpdir();
  const xdg = tmpdir();
  const dbPath = path.join(xdg, "opencode", "opencode.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, "placeholder");
  assert.equal(adapter.resolveDbPath({ home, env: { XDG_DATA_HOME: xdg } }), dbPath);
});

test("scan discovers sessions from a real v1.x database at the unix path", async () => {
  const home = tmpdir();
  buildDb(path.join(home, ".local", "share", "opencode"), { sessionTitle: "Scan me" });
  // scan() reads the real environment; point HOME-like inputs via env override.
  const sessions = await scanWithHome(home);
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.source, "opencode");
  assert.equal(session.externalId, "ses_test1");
  assert.equal(session.title, "Scan me");
  assert.equal(session.messageCount, 2);
  assert.ok(session.createdAt.startsWith("2026"));
});

test("convert restores text and tool messages in stored order", async () => {
  const home = tmpdir();
  buildDb(path.join(home, ".local", "share", "opencode"));
  const sessions = await scanWithHome(home);
  const { session, messages } = await adapter.convert(sessions[0]);
  assert.equal(session.id, "import-opencode-ses_test1");
  assert.equal(session.modelId, "test-model");
  assert.equal(session.providerId, "opencode");
  // user text, assistant text, assistant tool — in part order.
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "hello opencode"],
      ["assistant", "running it"],
      ["tool", "/tmp/proj"],
    ],
  );
  assert.equal(messages[2].toolName, "bash");
  assert.equal(messages[2].toolStatus, "success");
});

test("scan reports nothing when no database exists anywhere", async () => {
  const sessions = await scanWithHome(tmpdir());
  assert.deepEqual(sessions, []);
});

/** Runs adapter.scan() with HOME-like env pointing at a scratch root. */
async function scanWithHome(home) {
  const realHomedir = os.homedir();
  const realEnv = { ...process.env };
  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME;
  delete process.env.LOCALAPPDATA;
  // os.homedir() on darwin/linux honours $HOME; Windows keeps USERPROFILE, so
  // also override it for consistency.
  process.env.USERPROFILE = home;
  try {
    return await adapter.scan();
  } finally {
    process.env.HOME = realEnv.HOME;
    process.env.USERPROFILE = realEnv.USERPROFILE;
    if (realEnv.XDG_DATA_HOME) process.env.XDG_DATA_HOME = realEnv.XDG_DATA_HOME;
    if (realEnv.LOCALAPPDATA) process.env.LOCALAPPDATA = realEnv.LOCALAPPDATA;
  }
}
