/**
 * jsonl-transcript driver
 *
 * Reads "one JSON object per line" transcripts (the layout Claude Code,
 * Codex, WorkBuddy and Pi all use). Every app quirk is expressed in the spec
 * — role paths, content blocks, tool envelopes, timestamp units — so a new
 * JSONL source needs config, not code.
 *
 * Spec:
 *   root, extension, recursive, maxFiles, maxBytes
 *   session: { idFrom:"filename"|rule, titleFrom:"firstUser"|rule,
 *              projectFrom:"parentDir"|rule, fallbackProject }
 *   entry:   { rolePath, roleMap, content:rule, tsPath, tsUnit,
 *              skipTypePath, skipTypes[], tool:{ typePath, toolTypes[],
 *              namePath, argsPath, resultPath, statusPath } }
 */
"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { toIso, truncateTitle, projectNameOf } = require("../util");
const { extractText } = require("./extract");
const { resolveSafe, listFiles, readText, parseLines } = require("./fsutil");
const { mapEntries, firstUserText } = require("./entry-map");

const DRIVER = "jsonl-transcript";

function sessionTitle(sessionSpec, messages, file) {
  const from = sessionSpec?.titleFrom;
  if (from === "firstUser") {
    return truncateTitle(firstUserText(messages)) || path.basename(file, path.extname(file));
  }
  if (from && from !== "filename") {
    const t = extractText(from, messages[0]?.__raw ?? {}) || "";
    if (t) return truncateTitle(t);
  }
  return path.basename(file, path.extname(file));
}

async function scan(spec, sourceId) {
  const root = resolveSafe(spec.root);
  const files = await listFiles(root, {
    extension: spec.extension ?? ".jsonl",
    recursive: spec.recursive !== false,
    max: spec.maxFiles,
    maxBytes: spec.maxBytes,
  });
  const entrySpec = spec.entry ?? {};
  const sessionSpec = spec.session ?? {};

  const summaries = [];
  for (const file of files) {
    const raw = await readText(file, spec.maxBytes);
    if (raw == null) continue;
    const entries = parseLines(raw, spec.maxLines);
    if (!entries.length) continue;

    const messages = mapEntries(entrySpec, entries);
    if (!messages.length) continue;

    const ext = path.extname(file);
    const base = path.basename(file, ext);
    let externalId = base;
    if (sessionSpec.idFrom && sessionSpec.idFrom !== "filename") {
      const v = extractText(sessionSpec.idFrom, entries[0]);
      if (v) externalId = v;
    }

    const projectPath = path.dirname(file);
    const projectName =
      (sessionSpec.projectFrom === "parentDir" || !sessionSpec.projectFrom
        ? projectNameOf(projectPath)
        : extractText(sessionSpec.projectFrom, entries[0])) ||
      sessionSpec.fallbackProject ||
      null;

    let mtime = null;
    try {
      mtime = toIso((await fsp.stat(file)).mtimeMs);
    } catch {
      mtime = null;
    }

    const createdAt = messages[0]?.createdAt || mtime;
    const updatedAt = messages[messages.length - 1]?.createdAt || mtime || createdAt;

    summaries.push({
      source: sourceId,
      externalId,
      title: truncateTitle(sessionTitle(sessionSpec, messages, file)),
      fullTitle: sessionTitle(sessionSpec, messages, file),
      projectName,
      projectPath,
      modelId: null,
      providerId: null,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      filePath: file,
    });
  }
  return summaries;
}

async function convert(spec, summary) {
  const file = summary.filePath || resolveSafe(spec.root);
  const raw = await readText(file, spec.maxBytes);
  if (raw == null) return { session: null, messages: [] };
  const entries = parseLines(raw, spec.maxLines);
  const messages = mapEntries(spec.entry ?? {}, entries);

  return {
    session: {
      id: `import-${summary.source}-${summary.externalId}`,
      title: summary.fullTitle || summary.title,
      projectPath: summary.projectPath ?? null,
      modelId: null,
      providerId: null,
      mode: "agent",
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    },
    messages,
  };
}

module.exports = { driver: DRIVER, scan, convert };
