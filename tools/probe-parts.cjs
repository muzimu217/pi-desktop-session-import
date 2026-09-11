"use strict";
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(require("node:os").homedir() + "/.local/share/opencode/opencode.db", { readOnly: true });
try {
  const types = db.prepare("SELECT json_extract(data, '$.type') AS t, COUNT(*) AS c FROM part GROUP BY t").all();
  console.log("PART types:", JSON.stringify(types));
  const roles = db.prepare("SELECT json_extract(data, '$.role') AS r, COUNT(*) AS c FROM message GROUP BY r").all();
  console.log("MSG roles:", JSON.stringify(roles));
  const toolPart = db.prepare("SELECT data FROM part WHERE json_extract(data, '$.type') = 'tool' LIMIT 1").get();
  console.log("TOOL PART:", toolPart ? toolPart.data.slice(0, 500) : "(none)");
  const nonArchived = db.prepare("SELECT COUNT(*) AS c FROM session WHERE time_archived IS NULL AND title <> ''").get();
  const archived = db.prepare("SELECT COUNT(*) AS c FROM session WHERE time_archived IS NOT NULL").get();
  console.log("sessions nonArchived(titled):", JSON.stringify(nonArchived), "archived:", JSON.stringify(archived));
} finally { db.close(); }
