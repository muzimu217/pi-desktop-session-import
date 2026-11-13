import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const codex = require("../lib/sources/codex.js");

test("Codex adapter exports expected contract functions and constants", () => {
  assert.equal(codex.source, "codex");
  assert.equal(codex.label, "Codex");
  assert.equal(typeof codex.scan, "function");
  assert.equal(typeof codex.scanFast, "function");
  assert.equal(typeof codex.convert, "function");
  assert.ok(Array.isArray(codex.SYNTHETIC_USER_PREFIXES));
  assert.ok(codex.SYNTHETIC_USER_PREFIXES.length >= 10);
});

test("cleanPromptTitle and cleanUserMessageText strip IDE attachment wrapper", () => {
  const wrapped =
    "# Files mentioned by the user:\n\n## photo.png:\nC:\\path\\photo.png\n\n## My request:\n帮我分析这块电路 <image path=\"C:\\path\\photo.png\">";
  assert.equal(codex.cleanPromptTitle(wrapped), "帮我分析这块电路");
  assert.equal(
    codex.cleanUserMessageText(wrapped),
    "[附件: photo.png]\n\n帮我分析这块电路",
  );
});

test("formatQuestionReplyBlock extracts Q&A pairs safely", () => {
  const qreply =
    '<send_user_message_question_reply>[{"question":"是否开启Tun?","answer":"不开"}]</send_user_message_question_reply>';
  const formatted = codex.formatQuestionReplyBlock(qreply);
  assert.equal(formatted, "> 是否开启Tun?\n不开");
  assert.equal(codex.cleanUserMessageText(qreply), "> 是否开启Tun?\n不开");
});

test("scan and convert handle zst-compressed and paginated rollouts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
  try {
    const sessDir = path.join(tmp, ".codex", "sessions", "2026", "09", "07");
    fs.mkdirSync(sessDir, { recursive: true });

    const threadId = "01a072d4-aba5-7ff3-b117-826c19ae66fd";
    const seg1Name = `rollout-2026-09-06T02-28-55-${threadId}.jsonl.zst`;
    const seg2Name = `rollout-2026-09-07T15-52-44-${threadId}_01a07ada-f441-7680-8452-de77d89646cc.jsonl`;

    const lines1 = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: threadId,
          timestamp: "2026-09-05T18:28:55.334Z",
          cwd: "E:\\Projects\\TestWorkspace",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-05T18:28:57.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "第一阶段：项目初始化讨论" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-05T18:29:00.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "好的，我们开始初始化。" }],
        },
      }),
    ].join("\n");

    const compressed1 = zlib.zstdCompressSync(Buffer.from(lines1, "utf8"));
    fs.writeFileSync(path.join(sessDir, seg1Name), compressed1);

    const lines2 = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: threadId,
          timestamp: "2026-09-07T07:52:44.865Z",
          cwd: "E:\\Projects\\TestWorkspace",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-07T07:53:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "第二阶段：上传与测试" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-07T07:54:00.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "exec",
          input: { cmd: "echo test" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-07T07:54:05.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: "success",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-07T07:55:00.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "测试完成。" }],
        },
      }),
    ].join("\n");
    fs.writeFileSync(path.join(sessDir, seg2Name), lines2, "utf8");

    const sessions = await codex.scan(tmp);
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.externalId, threadId);
    assert.equal(s.title, "第一阶段：项目初始化讨论");
    assert.equal(s.projectName, "TestWorkspace");
    assert.equal(s.filePaths.length, 2);

    const conv = await codex.convert(s);
    assert.equal(conv.session.id, `import-codex-${threadId}`);
    assert.equal(conv.session.projectPath, "E:\\Projects\\TestWorkspace");
    assert.equal(conv.messages.length, 5);
    assert.equal(conv.messages[0].role, "user");
    assert.equal(conv.messages[0].content, "第一阶段：项目初始化讨论");
    assert.equal(conv.messages[2].role, "user");
    assert.equal(conv.messages[2].content, "第二阶段：上传与测试");
    assert.equal(conv.messages[3].role, "tool");
    assert.equal(conv.messages[3].toolName, "exec");
    assert.equal(conv.messages[4].role, "assistant");
    assert.equal(conv.messages[4].content, "测试完成。");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
