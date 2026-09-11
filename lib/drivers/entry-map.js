/**
 * Shared entry -> message mapper.
 *
 * Both the jsonl-transcript and json-tree drivers read a stream of "entries"
 * (one line / one array item) and turn each into a message using the same
 * declarative rules, so the mapping lives here rather than being duplicated.
 */
"use strict";

const { extractText, extractValue, getPath, mapRole, toIso } = require("./extract");

function mapToolStatus(status) {
  const s = status == null ? "" : String(status);
  if (s === "error" || s === "failed") return "error";
  if (s === "completed" || s === "success") return "success";
  return "running";
}

/** Turn one entry into 0..1 message using the spec's mapping. */
function mapEntry(entrySpec, entry) {
  if (!entry || typeof entry !== "object") return null;
  const spec = entrySpec ?? {};

  if (spec.skipTypePath && Array.isArray(spec.skipTypes) && spec.skipTypes.length) {
    const t = getPath(entry, spec.skipTypePath);
    if (t != null && spec.skipTypes.includes(t)) return null;
  }

  const ts = toIso(extractValue(spec.tsPath, entry), spec.tsUnit);

  const tool = spec.tool;
  if (tool && Array.isArray(tool.toolTypes) && tool.toolTypes.length) {
    const t = getPath(entry, tool.typePath || "type");
    if (tool.toolTypes.includes(t)) {
      const result = extractText(tool.resultPath, entry);
      return {
        role: "tool",
        content: result,
        toolName: extractText(tool.namePath, entry) || "tool",
        toolStatus: mapToolStatus(extractValue(tool.statusPath, entry)),
        toolArgs: extractValue(tool.argsPath, entry) ?? null,
        toolResult: result,
        createdAt: ts,
      };
    }
  }

  const role = mapRole(extractValue(spec.rolePath, entry), spec.roleMap);
  if (role !== "user" && role !== "assistant") return null;
  const content = extractText(spec.content, entry);
  if (!content) return null;
  return { role, content, createdAt: ts };
}

/** Map a whole transcript/session body to messages. */
function mapEntries(entrySpec, entries) {
  const messages = [];
  if (!Array.isArray(entries)) return messages;
  for (const entry of entries) {
    const msg = mapEntry(entrySpec, entry);
    if (msg) messages.push(msg);
  }
  return messages;
}

function firstUserText(messages) {
  for (const m of messages) {
    if (m.role === "user" && m.content) return m.content;
  }
  return "";
}

module.exports = { mapEntry, mapEntries, mapToolStatus, firstUserText };
