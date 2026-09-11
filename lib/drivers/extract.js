/**
 * Declarative value extraction used by every format driver.
 *
 * Drivers never embed app-specific logic; a spec describes *where* to look
 * (dotted path / block array / first-non-empty / literal) and these helpers
 * do the walking. That is what lets a new source be added as JSON instead of
 * a new .js adapter.
 */
"use strict";

/** Resolve a dotted path ("a.b.c" or "a.0.b") against an object. */
function getPath(obj, dotted) {
  if (obj == null || !dotted) return undefined;
  const parts = String(dotted).split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(p)] : cur[p];
  }
  return cur;
}

const isNonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;

/** Coerce any value to display text (objects/arrays -> JSON). */
function asText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/**
 * Extract text from one entry via a declarative rule. Accepted shapes:
 *   "a.b"                                   -> value at that path
 *   { path: "a.b" }                          -> value at that path
 *   { literal: "x" }                         -> constant
 *   { first: [rule, rule, ...] }             -> first non-empty result
 *   { blocks: { path, typeField, types, textField } }
 *        -> array at path; keep items whose typeField is in types (or all
 *           when types is empty); join their textField (or the item itself).
 */
function extractText(rule, entry) {
  if (!rule) return "";
  if (typeof rule === "string") return asText(getPath(entry, rule));
  if (typeof rule.literal === "string") return rule.literal;
  if (Array.isArray(rule.first)) {
    for (const sub of rule.first) {
      const v = extractText(sub, entry);
      if (v) return v;
    }
    return "";
  }
  if (rule.blocks) {
    const arr = getPath(entry, rule.blocks.path);
    if (!Array.isArray(arr)) return "";
    const texts = [];
    for (const item of arr) {
      if (item == null) continue;
      if (typeof item !== "object") {
        texts.push(asText(item));
        continue;
      }
      const t = rule.blocks.typeField ? getPath(item, rule.blocks.typeField) : undefined;
      if (Array.isArray(rule.blocks.types) && rule.blocks.types.length) {
        if (!rule.blocks.types.includes(t)) continue;
      }
      const txt = rule.blocks.textField ? getPath(item, rule.blocks.textField) : item;
      if (isNonEmptyStr(txt)) texts.push(txt);
      else if (txt != null) texts.push(asText(txt));
    }
    return texts.join("\n").trim();
  }
  if (rule.path) return asText(getPath(entry, rule.path));
  return "";
}

/** Extract a raw (unstringified) value — used for roles, ids, tool payloads. */
function extractValue(rule, entry) {
  if (!rule) return undefined;
  if (typeof rule === "string") return getPath(entry, rule);
  if (rule.path) return getPath(entry, rule.path);
  return undefined;
}

/** Map a raw role through a spec's roleMap, defaulting to the raw value. */
function mapRole(raw, roleMap) {
  const key = raw == null ? "" : String(raw);
  if (roleMap && Object.prototype.hasOwnProperty.call(roleMap, key)) {
    return String(roleMap[key]);
  }
  return key;
}

/** Normalize a timestamp (ms | s | iso string) to an ISO string. */
function toIso(value, unit) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = unit === "s" ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (/^\d+$/.test(value.trim()) && Number.isFinite(n)) {
      const ms = unit === "s" ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

module.exports = { getPath, asText, extractText, extractValue, mapRole, toIso };
