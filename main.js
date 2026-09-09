/**
 * Universal Session Import — plugin entry.
 *
 * Host injects global `pi`. The work-panel view drives this process through
 * custom `pluginBridge.invoke("import.*")` channels, forwarded to
 * `onPanelInvoke`:
 *
 *   import.scanSource  {source}              -> {found, count}  (cached)
 *   import.sessions    {source}              -> {sessions}
 *   import.convertBatch {source, items:[summary]} -> {sessions:[ImportedSession]}
 *
 * Converted sessions are imported by the panel through the host
 * "session.import" bridge, one call per session.
 */
"use strict";

const { ADAPTERS, getAdapter } = require("./lib/registry");

/** Scan results cached per source so switching sources never rescans. */
const cache = new Map();

async function onLoad() {
  await pi.commands.register({
    id: "session-import.open",
    title: "Session Import: Open Panel",
    keywords: ["import", "导入", "会话"],
    run: async () => {
      await pi.ui.openPanel({ title: "一体化会话导入" });
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("session-import.open");
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "import.adapters":
      return ADAPTERS.map((a) => ({ source: a.source, label: a.label }));
    case "import.scanSource":
      return scanSource(payload);
    case "import.sessions":
      return sessions(payload);
    case "import.convertBatch":
      return convertBatch(payload);
    default:
      throw new Error(`unknown channel: ${channel}`);
  }
}

async function scanSource(payload) {
  const source = String(payload?.source ?? "");
  const adapter = getAdapter(source);
  if (!adapter) throw new Error(`unknown source: ${source}`);
  if (cache.has(source)) {
    const sessions = cache.get(source);
    return { source, found: sessions.length > 0, count: sessions.length };
  }
  let sessions = [];
  try {
    sessions = await adapter.scan();
  } catch {
    sessions = [];
  }
  cache.set(source, sessions);
  return { source, found: sessions.length > 0, count: sessions.length };
}

function sessions(payload) {
  const source = String(payload?.source ?? "");
  if (!cache.has(source)) throw new Error(`source not scanned: ${source}`);
  return { source, sessions: cache.get(source) };
}

async function convertBatch(payload) {
  const source = String(payload?.source ?? "");
  const adapter = getAdapter(source);
  if (!adapter) throw new Error(`unknown source: ${source}`);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) throw new Error("nothing selected to import");

  const sessions = [];
  let unreadable = 0;
  for (const item of items) {
    try {
      const conv = await adapter.convert(item);
      // Host UiMessage requires an id on every message; adapters describe
      // content only, so allocate ids here in one place.
      conv.messages = conv.messages.map((m) => ({
        id: crypto.randomUUID(),
        ...m,
      }));
      sessions.push(conv);
    } catch {
      unreadable += 1;
    }
  }
  return { ok: true, source, sessions, unreadable };
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
};
