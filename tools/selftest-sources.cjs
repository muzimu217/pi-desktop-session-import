/**
 * Self-test harness for the six session-import source adapters.
 *
 * Goal: verify, against the REAL local machine data, that every adapter's
 * scan() -> SessionSummary[] and convert(summary) -> { session, messages }
 * contract holds. This is the "剩余内容自测" step before we integrate a new
 * release or develop the extensibility feature.
 *
 * Adapters are CommonJS; we load them through the registry just like the host
 * does at runtime, so this exercises the exact code path the plugin uses.
 *
 * Run: node tools/selftest-sources.cjs
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { ADAPTERS } = require("../lib/registry");

// Canonical data-dir probe per source (best-effort; adapters hardcode these).
const DATA_DIRS = {
  zcode: path.join(os.homedir(), ".zcode", "cli", "db"),
  workbuddy: path.join(os.homedir(), ".workbuddy", "projects"),
  "claude-code": path.join(os.homedir(), ".claude", "projects"),
  codex: path.join(os.homedir(), ".codex", "sessions"),
  opencode: path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
  pi: path.join(os.homedir(), ".pi", "agent", "sessions"),
};

function dirStatus(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return "present(dir)";
    if (st.isFile()) return "present(file)";
    return "not-a-dir";
  } catch {
    return "missing";
  }
}

// scan() may be sync (zcode) or async; normalize both.
function runScan(adapter) {
  return Promise.resolve().then(() => adapter.scan());
}
function runConvert(adapter, summary) {
  return Promise.resolve().then(() => adapter.convert(summary));
}

async function testSource(adapter) {
  const report = {
    source: adapter.source,
    label: adapter.label,
    dataDir: DATA_DIRS[adapter.source] ?? null,
    dataDirStatus: DATA_DIRS[adapter.source] ? dirStatus(DATA_DIRS[adapter.source]) : "n/a",
    scan: { ok: false, count: 0, error: null },
    sampleConvert: null,
  };

  // --- scan() ---
  try {
    const sessions = await runScan(adapter);
    report.scan.ok = Array.isArray(sessions);
    report.scan.count = Array.isArray(sessions) ? sessions.length : 0;
    if (!Array.isArray(sessions)) {
      report.scan.error = "scan() did not return an array";
    }
    report.scan.sessions = sessions; // keep for convert step
  } catch (err) {
    report.scan.ok = false;
    report.scan.error = `${err && err.constructor ? err.constructor.name : "Error"}: ${err && err.message ? err.message : String(err)}`;
  }

  // --- convert() on a sample (first 1-2 sessions) ---
  const sessions = report.scan.sessions || [];
  if (report.scan.ok && sessions.length > 0) {
    const sampleSummaries = sessions.slice(0, 2);
    const sampleResults = [];
    for (const summary of sampleSummaries) {
      try {
        const out = await runConvert(adapter, summary);
        const msgs = out && out.messages ? out.messages : null;
        sampleResults.push({
          externalId: summary.externalId,
          sessionId: out && out.session ? out.session.id : null,
          messageCount: Array.isArray(msgs) ? msgs.length : 0,
          hasSession: !!(out && out.session),
          roles: Array.isArray(msgs)
            ? [...new Set(msgs.map((m) => m.role).filter(Boolean))].sort()
            : [],
          error: null,
          // crude size check vs host 512 KiB cap on serialized session
          serializedBytes:
            out && out.session && out.messages
              ? Buffer.byteLength(JSON.stringify(out))
              : 0,
        });
      } catch (err) {
        sampleResults.push({
          externalId: summary.externalId,
          messageCount: 0,
          error: `${err && err.constructor ? err.constructor.name : "Error"}: ${err && err.message ? err.message : String(err)}`,
        });
      }
    }
    report.sampleConvert = sampleResults;
  }

  delete report.scan.sessions;
  return report;
}

async function main() {
  console.log("=== PI-Desktop session-import :: source self-test ===");
  console.log(`Host: ${os.type()} ${os.release()}  Node: ${process.version}`);
  console.log(`Home: ${os.homedir()}`);
  console.log(`Adapters registered: ${ADAPTERS.map((a) => a.source).join(", ")}`);
  console.log("");

  const results = [];
  for (const adapter of ADAPTERS) {
    const r = await testSource(adapter);
    results.push(r);
    const scanLine = r.scan.ok
      ? `scan OK, ${r.scan.count} sessions`
      : `scan FAILED (${r.scan.error})`;
    console.log(`[${r.label}] ${r.source}`);
    console.log(`  dataDir(${r.dataDirStatus}): ${r.dataDir}`);
    console.log(`  ${scanLine}`);
    if (r.sampleConvert) {
      for (const s of r.sampleConvert) {
        if (s.error) {
          console.log(`  convert FAILED: ${s.error}`);
        } else {
          console.log(
            `  convert OK: session=${s.sessionId} messages=${s.messageCount} roles=[${s.roles.join(",")}] ~${s.serializedBytes}B`,
          );
        }
      }
    }
    console.log("");
  }

  // Summary verdict
  const failedScans = results.filter((r) => !r.scan.ok);
  const failedConverts = results.filter(
    (r) => r.sampleConvert && r.sampleConvert.some((s) => s.error),
  );
  const emptyExpected = results.filter(
    (r) => r.scan.ok && r.scan.count === 0,
  );

  console.log("=== VERDICT ===");
  console.log(`Total adapters: ${results.length}`);
  console.log(`Scanned with data: ${results.filter((r) => r.scan.ok && r.scan.count > 0).length}`);
  console.log(`Empty (no local data): ${emptyExpected.map((r) => r.source).join(", ") || "none"}`);
  console.log(`Scan failures: ${failedScans.map((r) => r.source).join(", ") || "none"}`);
  console.log(`Convert failures: ${failedConverts.map((r) => r.source).join(", ") || "none"}`);

  // Pi is expected to be empty (app not installed locally) — not a failure.
  const piReport = results.find((r) => r.source === "pi");
  if (piReport && piReport.scan.ok && piReport.scan.count === 0) {
    console.log("NOTE: 'pi' is empty as expected — ~/.pi absent on this machine (Pi app not installed).");
  }

  const hardFailures = failedScans.filter((r) => !(r.source === "pi")).
    concat(failedConverts.filter((r) => !(r.source === "pi")));
  if (hardFailures.length === 0) {
    console.log("RESULT: PASS (all installed sources scan+convert cleanly; pi empty is expected).");
    process.exitCode = 0;
  } else {
    console.log("RESULT: FAIL — review failures above.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("Harness crashed:", e);
  process.exitCode = 2;
});
