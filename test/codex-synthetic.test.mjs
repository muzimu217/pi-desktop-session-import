// Codex synthetic-user prefix table (M0 parity with the host importer,
// evidence list from PI-Desktop #265): every evidenced IDE/instruction prefix
// must be filtered from titles and user messages.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const codex = require("../lib/sources/codex.js");

test("the synthetic prefix table carries the full evidenced list", () => {
  assert.equal(codex.SYNTHETIC_USER_PREFIXES.length, 10);
  for (const prefix of [
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
  ]) {
    assert.ok(
      codex.SYNTHETIC_USER_PREFIXES.includes(prefix),
      `missing evidenced prefix: ${prefix}`,
    );
  }
});

test("isSyntheticUserText filters IDE-context injections but keeps real users", () => {
  for (const synthetic of [
    "<system-reminder>",
    "# AGENTS.md instructions",
    "# Context from my IDE setup",
    "You are Codex, an agent",
  ]) {
    assert.equal(codex.isSyntheticUserText(synthetic), true, synthetic);
  }
  // Real pasted markdown may start with "#" — never blanket-filtered.
  assert.equal(codex.isSyntheticUserText("# Role: you are a helper"), false);
  assert.equal(codex.isSyntheticUserText("帮我看看这个报错"), false);
});
