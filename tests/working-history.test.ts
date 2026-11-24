import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import type Anthropic from "@anthropic-ai/sdk";
import { compressWorkingHistory, estimateTokens, replaceHistory, type ContextOptions } from "../examples/context.ts";
import { createAgent as hooks } from "../examples/14-with-hooks.ts";
import { createAgent as integrated } from "../examples/24-integrated-agent.ts";

type Message = Anthropic.MessageParam;
const text = (value: string): Pick<Anthropic.Message, "content"> =>
  ({ content: [{ type: "text", text: value, citations: null }] });
function history(): Message[] {
  return [
    { role: "user", content: "旧任务：" + "x".repeat(8_000) },
    { role: "assistant", content: "已改 Button.tsx" },
    { role: "user", content: "核对按钮" },
    { role: "assistant", content: [{ type: "tool_use", id: "read", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "blue" }] },
    { role: "assistant", content: "按钮为 blue" },
  ];
}
const defaults = { modelName: "history-test", thresholdTokens: 1_000, log: () => {} };

test("压缩写回相同数组，最近工具轮次完整，短追问不重复摘要", async () => {
  const messages = history();
  const reference = messages;
  const recent = structuredClone(messages.slice(2));
  const requests: Parameters<ContextOptions["model"]["create"]>[0][] = [];
  const options: ContextOptions = { ...defaults, model: { create: async (request) => {
    requests.push(request);
    return text("用户要求修改 Button.tsx，当前已完成，待核对。");
  } } };
  await compressWorkingHistory(messages, options);
  assert.equal(messages, reference);
  assert.match(messages[0].content as string, /^\[对话摘要\]/);
  assert.deepEqual(messages.slice(2), recent);
  assert.equal(requests[0].model, "history-test");
  assert.equal(requests[0].tools.length, 0);
  assert.doesNotMatch(requests[0].messages[0].content as string, /核对按钮/);
  messages.push({ role: "user", content: "然后继续" });
  await compressWorkingHistory(messages, options);
  assert.equal(requests.length, 1);
  assert.equal(messages.at(-1)?.content, "然后继续");
});

test("清理和截断保留工具 id 与错误状态，空工具结果不会丢失", async () => {
  const messages: Message[] = [{ role: "user", content: " " }];
  for (let index = 0; index < 8; index++) {
    messages.push(
      { role: "assistant", content: [{ type: "text", text: " " }, { type: "tool_use", id: String(index), name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: String(index), is_error: true,
        content: index === 7 ? "" : [{ type: "text", text: "a".repeat(100) }, { type: "text", text: "b".repeat(100) }] }] },
    );
  }
  await compressWorkingHistory(messages, {
    ...defaults, thresholdTokens: Infinity, maxResultChars: 20,
    model: { create: async () => { throw new Error("不应调用"); } },
  });
  assert.equal(messages.length, 16);
  const result = (index: number) => (messages[index * 2 + 1].content as Anthropic.ToolResultBlockParam[])[0];
  for (let index = 0; index < 8; index++) {
    assert.equal(result(index).tool_use_id, String(index));
    assert.equal(result(index).is_error, true);
  }
  assert.match(result(0).content as string, /已清除/);
  assert.match(JSON.stringify(result(2).content), /已截断/);
  assert.doesNotMatch(JSON.stringify(result(2).content), /a{21}|b{21}/);
  assert.equal(result(7).content, "");
});

test("失败、空摘要和更长摘要都保留现有历史", async () => {
  for (const create of [
    async () => { throw new Error("模拟网络故障"); },
    async () => text(" \n "),
    async () => text("y".repeat(20_000)),
  ]) {
    const messages = history();
    const before = structuredClone(messages);
    await compressWorkingHistory(messages, { ...defaults, model: { create } });
    assert.deepEqual(messages, before);
  }
});

test("没有可压缩完整轮次时跳过摘要，取消仍向上传递", async () => {
  const messages = history().slice(2);
  await compressWorkingHistory(messages, {
    ...defaults, thresholdTokens: 0,
    model: { create: async () => { assert.fail("单个工具轮次不能拆开"); } },
  });
  const abort = new AbortController();
  await assert.rejects(compressWorkingHistory(history(), {
    ...defaults, signal: abort.signal,
    model: { create: async () => { abort.abort(); throw new Error("取消"); } },
  }), /abort/i);
});

for (const [name, factory] of [["第 14 章", hooks], ["第 24 章", integrated]] as const) {
  test(`${name} 请求使用已压缩工作历史，下一轮继续同一份摘要`, async (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "working-history-loop-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    let summaries = 0;
    const executionRequests: Message[][] = [];
    const model: ContextOptions["model"] = { create: async (request) => {
      if (request.system.startsWith("总结这段编程对话")) { summaries++; return text("已修改 Button.tsx。"); }
      executionRequests.push(structuredClone(request.messages));
      return text("完成");
    } };
    const evaluator = { create: async () => text('{"status":"blocked","reason":"等待用户提供检查条件","evidence_ids":[]}') };
    const agent = await factory({ cwd, model, evaluator, contextThreshold: 1_000, log: () => {} });
    t.after(() => agent.close());
    const reference = agent.messages;
    agent.messages.push(...history());
    await agent.agentLoop("继续");
    assert.equal(agent.messages, reference);
    assert.match(executionRequests[0][0].content as string, /^\[对话摘要\]/);
    assert.doesNotMatch(JSON.stringify(executionRequests), /x{100}/);
    await agent.agentLoop("再继续");
    assert.equal(summaries, 1);
    assert.equal(executionRequests[1][0].content, executionRequests[0][0].content);
  });
}

test("第 12 章保存压缩快照并覆盖旧记录，重复恢复不重复消息", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "working-history-session-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(new URL("../examples/12-with-persistence.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("persistence.ts", source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && ["saveSession", "loadSession"].includes(node.name?.text ?? ""));
  assert.equal(functions.length, 2);
  const script = ts.transpile(functions.map((node) => node.getText(ast)).join("\n"), { target: ts.ScriptTarget.ES2022 });
  const sessionFile = path.join(directory, "session.jsonl");
  const context = vm.createContext({ fs, AGENT_DIR: directory, SESSION_FILE: sessionFile });
  vm.runInContext(script, context);
  const messages = history();
  context.saveSession(messages);
  const originalBytes = fs.statSync(sessionFile).size;
  await compressWorkingHistory(messages, { ...defaults, model: { create: async () => text("已改按钮。") } });
  context.saveSession(messages);
  assert.ok(fs.statSync(sessionFile).size < originalBytes);
  assert.ok(estimateTokens(messages) < 1_000);
  const restored: Message[] = [];
  // JSON roundtrip removes VM realm prototypes for comparisons.
  const loaded = () => JSON.parse(JSON.stringify(context.loadSession())) as Message[];
  replaceHistory(restored, loaded());
  replaceHistory(restored, loaded());
  assert.deepEqual(restored, messages);
  assert.doesNotMatch(fs.readFileSync(sessionFile, "utf8"), /x{100}/);
  assert.equal(fs.existsSync(sessionFile + ".tmp"), false);
});
