// 第 22 章：工作流、事件与恢复。工具、状态和 agentLoop 都在本文件内。

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

type Message = Anthropic.MessageParam;
export interface Model {
  create(request: { model: string; max_tokens: number; system: string; tools: Anthropic.Tool[]; messages: Message[] },
    options?: { signal?: AbortSignal }): Promise<Pick<Anthropic.Message, "content">>;
}
interface Tool { definition: Anthropic.Tool; schema: z.ZodType; call(input: any): Promise<string> | string }
// 每个工具都同时声明模型看到的 JSON Schema 和执行器使用的 Zod 校验。
function tool(name: string, description: string, schema: z.ZodType,
  properties: Record<string, unknown>, required: string[], call: Tool["call"]): Tool {
  return { definition: { name, description, input_schema: { type: "object", properties, required } }, schema, call };
}
const string = { type: "string" };
function atomicWrite(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

export const PlanSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  steps: z.array(z.object({ id: z.string().min(1), action: z.string(), input: z.record(z.unknown()) })).min(1).max(20),
});
type Plan = z.infer<typeof PlanSchema>;
export interface Action {
  schema: z.ZodType;
  run(input: any, signal: AbortSignal): Promise<string> | string;
  verify(input: any, output: string): boolean;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function fileActions(cwd: string): Record<string, Action> {
  const file = (input: { file_path: string }) => path.resolve(cwd, input.file_path);
  return {
    read: {
      schema: z.object({ file_path: z.string() }).strict(),
      run: (input) => fs.readFileSync(file(input), "utf8"),
      verify: (input, output) => fs.existsSync(file(input)) && fs.readFileSync(file(input), "utf8") === output,
    },
    write: {
      schema: z.object({ file_path: z.string(), content: z.string() }).strict(),
      run: (input) => {
        if (path.basename(file(input)).startsWith(".env")) throw new Error("工作流不写凭据文件");
        fs.mkdirSync(path.dirname(file(input)), { recursive: true }); fs.writeFileSync(file(input), input.content); return digest(input.content);
      },
      verify: (input, output) => fs.existsSync(file(input)) && digest(fs.readFileSync(file(input), "utf8")) === output,
    },
    assert_file: {
      schema: z.object({ file_path: z.string(), content: z.string() }).strict(),
      run: (input) => {
        const actual = fs.readFileSync(file(input), "utf8");
        if (actual !== input.content) throw new Error("文件内容不符合预期");
        return digest(actual);
      },
      verify: (input, output) => fs.existsSync(file(input)) && digest(fs.readFileSync(file(input), "utf8")) === output,
    },
  };
}
const RunSchema = z.object({
  hash: z.string(), attempts: z.number().int().nonnegative(),
  completed: z.record(z.object({ output: z.string() })),
  events: z.array(z.object({ step: z.string(), type: z.enum(["started", "completed", "failed", "cached"]), detail: z.string() })),
});
export class WorkflowRunner {
  constructor(readonly directory: string, readonly registry: Record<string, Action>) { fs.mkdirSync(directory, { recursive: true }); }
  async run(value: unknown, options: { maxCalls?: number; signal?: AbortSignal; timeoutMs?: number } = {}) {
    const plan = PlanSchema.parse(value);
    if (new Set(plan.steps.map((step) => step.id)).size !== plan.steps.length) throw new Error("步骤 id 重复");
    // 在任何副作用发生前，检查所有 action 和输入；不能由模型注册任意执行代码。
    for (const step of plan.steps) {
      const action = this.registry[step.action];
      if (!action) throw new Error("未注册 action：" + step.action);
      action.schema.parse(step.input);
    }
    const file = path.join(this.directory, plan.id + ".json");
    const lock = file + ".lock";
    try { fs.mkdirSync(lock); } catch { throw new Error("工作流正在执行"); }
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
    try {
      const hash = digest(JSON.stringify(plan));
      const state = fs.existsSync(file) ? RunSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : { hash, attempts: 0, completed: {}, events: [] } as z.infer<typeof RunSchema>;
      if (state.hash !== hash) throw new Error("同一工作流 id 不可更换计划；请用新 id");
      const event = (step: string, type: "started" | "completed" | "failed" | "cached", detail = "") => {
        state.events.push({ step, type, detail }); atomicWrite(file, state);
      };
      for (const step of plan.steps) {
        signal.throwIfAborted();
        const action = this.registry[step.action];
        const input = action.schema.parse(step.input);
        const cached = state.completed[step.id];
        if (cached) {
          // 不能只看 completed：重启后先核对真实文件，避免复用过期结果。
          if (!action.verify(input, cached.output)) throw new Error("已完成步骤证据过期：" + step.id);
          event(step.id, "cached"); continue;
        }
        if (state.attempts >= (options.maxCalls ?? 20)) throw new Error("工作流执行预算耗尽");
        state.attempts++; event(step.id, "started");
        try {
          const output = await action.run(input, signal);
          signal.throwIfAborted();
          if (!action.verify(input, output)) throw new Error("执行结果无法验证");
          state.completed[step.id] = { output }; event(step.id, "completed", output.slice(0, 200));
        } catch (error) {
          event(step.id, "failed", String(error)); throw error;
        }
      }
      return { status: "completed", attempts: state.attempts, results: state.completed, events: state.events };
    } finally { fs.rmdirSync(lock); }
  }
}

export async function createAgent(options: {
  cwd?: string; model?: Model; maxTurns?: number; log?: (text: string) => void;
  evaluator?: Model; goal?: string; maxEvaluations?: number;
} = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const MODEL = process.env.MODEL?.trim() || "trae-internal/openrouter-3o";
  let client: Anthropic | undefined;
  const model: Model = options.model ?? { create: (request, opts) => {
    client ??= new Anthropic({ timeout: 120_000, maxRetries: 0 });
    return client.messages.create(request, opts);
  } };
  const log = options.log ?? console.log;
  const abort = new AbortController();
  const messages: Message[] = [];
  const workflow = new WorkflowRunner(path.join(cwd, ".runtime", "workflows"), fileActions(cwd));
  const tools: Tool[] = [
    tool("read_file", "读取工作目录中的 UTF-8 文件。", z.object({ file_path: z.string() }),
      { file_path: string }, ["file_path"], (input) => fs.readFileSync(path.resolve(cwd, input.file_path), "utf8")),
    tool("write_file", "创建或覆盖 UTF-8 文件。", z.object({ file_path: z.string(), content: z.string() }),
      { file_path: string, content: string }, ["file_path", "content"], (input) => {
        const file = path.resolve(cwd, input.file_path);
        if (path.basename(file).startsWith(".env")) throw new Error("本示例不写入凭据文件");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, input.content);
        return "已写入 " + input.file_path;
      }),
    
    tool("workflow_run", "执行或恢复注册工作流；同一 id 的计划必须保持不变。",
      z.object({ plan: PlanSchema }), { plan: { type: "object", properties: { id: string, steps: { type: "array", items: {
        type: "object", properties: { id: string, action: { type: "string", enum: ["read", "write", "assert_file"] },
          input: { type: "object", additionalProperties: true } }, required: ["id", "action", "input"] } } }, required: ["id", "steps"] } },
      ["plan"], async (input) => JSON.stringify(await workflow.run(input.plan, { signal: abort.signal }))),

  ];
  async function execute(block: Anthropic.ToolUseBlock): Promise<string> {
    try {
      abort.signal.throwIfAborted();
      
      const selected = tools.find((entry) => entry.definition.name === block.name);
      if (!selected) throw new Error("未知工具 " + block.name);
      const input = selected.schema.parse(block.input);
      const output = await selected.call(input);
      
      return output.length > 12_000 ? output.slice(0, 12_000) + "\n[输出已截断]" : output;
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  }
  // 看清这段循环：模型输出 -> 真正执行工具 -> 配对 tool_result -> 再问模型。
  async function agentLoop(query: string): Promise<string> {
    
    messages.push({ role: "user", content: query });
    for (let turn = 0; turn < (options.maxTurns ?? 20); turn++) {
      abort.signal.throwIfAborted();
      
      const response = await model.create({
        model: MODEL, max_tokens: 4096,
        system: "你是 " + cwd + " 中的编程助手，回答用中文。工作流只支持注册的 read/write/assert_file，步骤依次执行。失败后恢复相同 id 和完全相同计划，改变计划必须用新 id。",
        tools: tools.map((entry) => entry.definition), messages: structuredClone(messages),
      }, { signal: abort.signal });
      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      if (calls.length === 0) {
        
        return response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of calls) {
        log("[工具] " + block.name);
        const output = await execute(block);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output, is_error: output.startsWith("Error:") });
      }
      messages.push({ role: "user", content: results });
    }
    return "[已达到轮次上限]";
  }
  async function close() { abort.abort();  }
  return { agentLoop, execute, messages, tools, close, workflow };
}
export async function demo() {

  const os = await import("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-course-"));
  try {
    const plan = { id: "demo", steps: [
      { id: "write", action: "write", input: { file_path: "result.txt", content: "OK" } },
      { id: "check", action: "assert_file", input: { file_path: "result.txt", content: "OK" } },
    ] };
    const first = new WorkflowRunner(path.join(directory, "runs"), fileActions(directory));
    console.log(await first.run(plan));
    const restored = new WorkflowRunner(path.join(directory, "runs"), fileActions(directory));
    console.log("恢复复用", await restored.run(plan));
    fs.writeFileSync(path.join(directory, "result.txt"), "被外部修改");
    try { await restored.run(plan); } catch (error) { console.log("拒绝陈旧证据", String(error)); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }

}

export async function main() {
  if (process.argv.includes("--help")) {
    console.log("pnpm run example:22 -- --prompt \"用 workflow_run 创建 wf-demo 工作流，写入 wf-demo.txt 内容为 OK，再用 assert_file 核对。\"；不传 --prompt 进入交互终端。 --demo 是无需模型的机制演示，具体注入与协议范围见章节。");
    return;
  }
  if (process.argv.includes("--demo")) { await demo(); return; }
  const index = process.argv.indexOf("--prompt");
  const goalIndex = process.argv.indexOf("--goal");
  const agent = await createAgent({ goal: goalIndex >= 0 ? process.argv[goalIndex + 1] : undefined });
  if (index >= 0) {
    try { console.log(await agent.agentLoop(process.argv[index + 1] ?? "")); }
    finally { await agent.close(); }
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stop = () => { void agent.close(); rl.close(); };
  process.once("SIGINT", stop);
  console.log("工作流、事件与恢复。输入 q 或 exit 退出。");
  try {
    for await (const input of rl) {
      if (/^(q|exit)$/i.test(input.trim())) break;
      if (!input.trim()) continue;
      try { console.log(await agent.agentLoop(input)); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    }
  } finally { process.off("SIGINT", stop); rl.close(); await agent.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
