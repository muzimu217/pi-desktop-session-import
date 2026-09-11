/**
 * Robustness / safety unit tests for the C work (timeout watchdog, dedup,
 * contract truncation). Runs against the real code in ../main.js with no host
 * (`pi` is never touched by the exported helpers).
 *
 *   node tools/test-robustness.cjs
 */
"use strict";

const assert = require("node:assert");
const main = require("../main");

let pass = 0;
let fail = 0;
function check(name, fn) {
  const started = Date.now();
  Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  PASS  ${name}  (${Date.now() - started}ms)`);
    })
    .catch((e) => {
      fail += 1;
      console.log(`  FAIL  ${name}  -> ${e && e.message ? e.message : e}`);
    });
}

// --- withTimeout -----------------------------------------------------------

check("withTimeout resolves a synchronous return as a promise (uniform)", async () => {
  const r = await main.withTimeout(() => 42, 1000, "sync");
  assert.strictEqual(r, 42);
});

check("withTimeout does NOT delay a synchronous return", async () => {
  const start = Date.now();
  const r = await main.withTimeout(() => "x", 1, "sync");
  assert.strictEqual(r, "x");
  assert.ok(Date.now() - start < 500, "sync call was delayed");
});

check("withTimeout resolves an async value before the deadline", async () => {
  const r = await main.withTimeout(async () => "ok", 1000, "async");
  assert.strictEqual(r, "ok");
});

check("withTimeout rejects with code TIMEOUT past the deadline", async () => {
  let threw = false;
  try {
    // A promise that never settles — the exact shape of a hung source scan.
    await main.withTimeout(() => new Promise(() => {}), 20, "hang");
  } catch (e) {
    threw = true;
    assert.strictEqual(e.code, "TIMEOUT");
  }
  assert.strictEqual(threw, true, "expected a timeout rejection");
});

check("withTimeout rejects synchronous throws as a normal rejection", async () => {
  let threw = false;
  try {
    await main.withTimeout(() => {
      throw new Error("boom");
    }, 1000, "throws");
  } catch (e) {
    threw = true;
    assert.strictEqual(e.message, "boom");
  }
  assert.strictEqual(threw, true);
});

// --- enforceContractLimits --------------------------------------------------

check("enforceContractLimits truncates oversized content and flags it", () => {
  const big = "A".repeat(600 * 1024); // ~600 KiB raw, > 512 KiB budget
  const session = {
    externalId: "x",
    title: "t",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [{ role: "user", content: big }],
  };
  const { session: out, truncated } = main.enforceContractLimits(session);
  assert.strictEqual(truncated, true);
  const bytes = Buffer.byteLength(JSON.stringify(out.messages[0].content), "utf8");
  assert.ok(bytes <= 512 * 1024, `content still ${bytes} bytes (over cap)`);
});

// --- toContractSession -----------------------------------------------------

check("toContractSession caps messages at 2000 and flags truncation", () => {
  const msgs = [];
  for (let i = 0; i < 2500; i += 1) {
    msgs.push({ role: "user", content: "hi", createdAt: new Date().toISOString() });
  }
  const conv = {
    session: {
      id: "s",
      title: "T",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    messages: msgs,
  };
  const { session, truncated } = main.toContractSession({ externalId: "s" }, conv, null);
  assert.ok(session.messages.length <= 2000, `msgs ${session.messages.length}`);
  assert.strictEqual(truncated, true, "message-count cap must flag truncated");
});

check("toContractSession leaves a small session unflagged", () => {
  const conv = {
    session: { id: "s", title: "T", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    messages: [{ role: "user", content: "short", createdAt: new Date().toISOString() }],
  };
  const { session, truncated } = main.toContractSession({ externalId: "s" }, conv, null);
  assert.strictEqual(session.messages.length, 1);
  assert.strictEqual(truncated, false);
});

// --- dedupeSummaries -------------------------------------------------------

check("dedupeSummaries removes duplicate externalIds and flags oversized", () => {
  const sessions = [
    { source: "zcode", externalId: "a", messageCount: 10 },
    { source: "zcode", externalId: "a", messageCount: 10 }, // duplicate
    { source: "zcode", externalId: "b", messageCount: 3000 }, // oversized
    { source: "zcode", externalId: "c", messageCount: 5 },
  ];
  const { deduped, oversizedCount } = main.dedupeSummaries(sessions, "zcode");
  assert.strictEqual(deduped.length, 3, "duplicate not removed");
  assert.strictEqual(oversizedCount, 1, "oversized not counted");
  assert.strictEqual(deduped.find((s) => s.externalId === "b").oversized, true);
});

check("dedupeSummaries is a no-op for distinct summaries", () => {
  const sessions = [
    { source: "zcode", externalId: "a", messageCount: 10 },
    { source: "zcode", externalId: "b", messageCount: 20 },
  ];
  const { deduped, oversizedCount } = main.dedupeSummaries(sessions, "zcode");
  assert.strictEqual(deduped.length, 2);
  assert.strictEqual(oversizedCount, 0);
});

// --- summary ---------------------------------------------------------------

setTimeout(() => {
  console.log(`\nrobustness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 200);
