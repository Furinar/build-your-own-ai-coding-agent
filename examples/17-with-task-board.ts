// 第 17 章：持久任务与依赖图。工具、状态和 agentLoop 都在本文件内。

import Anthropic from "@anthropic-ai/sdk";
import { compressWorkingHistory } from "./context";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";

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

export const TaskSchema = z.object({
  id: z.string(), title: z.string(), dependsOn: z.array(z.string()),
  status: z.enum(["pending", "running", "completed"]), owner: z.string().optional(), version: z.number().int(),
});
type Task = z.infer<typeof TaskSchema>;
export class TaskBoard {
  readonly file: string;
  constructor(readonly directory: string) { this.file = path.join(directory, "board.json"); fs.mkdirSync(directory, { recursive: true }); }
  snapshot(): Task[] { return fs.existsSync(this.file) ? z.array(TaskSchema).parse(JSON.parse(fs.readFileSync(this.file, "utf8"))) : []; }
  // mkdir 的排他性跨进程有效；本例锁冲突立即返回，调用方稍后重试。
  transaction<T>(operation: (tasks: Task[]) => T): T {
    const lock = path.join(this.directory, "board.lock");
    try { fs.mkdirSync(lock); } catch { throw new Error("任务板正被其他进程更新，请重试"); }
    try {
      const tasks = this.snapshot();
      const result = operation(tasks);
      atomicWrite(this.file, tasks);
      return result;
    } finally { fs.rmdirSync(lock); }
  }
  add(id: string, title: string, dependsOn: string[] = []) {
    if (!id.trim() || !title.trim()) throw new Error("id 和标题不能为空");
    return this.transaction((tasks) => {
      if (tasks.some((task) => task.id === id)) throw new Error("任务 id 已存在");
      if (new Set(dependsOn).size !== dependsOn.length) throw new Error("依赖不能重复");
      if (dependsOn.some((dependency) => !tasks.some((task) => task.id === dependency))) throw new Error("依赖必须是已有任务");
      // 只能指向已经存在的节点，所以新增边不可能形成环。
      const task: Task = { id, title, dependsOn, status: "pending", version: 1 };
      tasks.push(task);
      return task;
    });
  }
  claim(id: string, owner: string) {
    if (!owner.trim()) throw new Error("owner 不能为空");
    return this.transaction((tasks) => {
      const task = tasks.find((item) => item.id === id);
      if (!task || task.status !== "pending") throw new Error("任务不存在或已被领取");
      if (task.dependsOn.some((dependency) => tasks.find((item) => item.id === dependency)?.status !== "completed")) throw new Error("依赖尚未完成");
      task.status = "running"; task.owner = owner; task.version++;
      return { ...task };
    });
  }
  complete(id: string, owner: string, version: number) {
    return this.transaction((tasks) => {
      const task = tasks.find((item) => item.id === id);
      if (!task || task.status !== "running" || task.owner !== owner || task.version !== version) throw new Error("领取者或任务版本不匹配");
      task.status = "completed"; task.version++;
      return { ...task };
    });
  }
}

export async function createAgent(options: {
  cwd?: string; model?: Model; maxTurns?: number; contextThreshold?: number; log?: (text: string) => void;
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
  const board = new TaskBoard(path.join(cwd, ".tasks"));
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
    
    tool("task_list", "查看持久任务和依赖。", z.object({}), {}, [], () => JSON.stringify(board.snapshot())),
    tool("task_create", "创建任务；依赖必须先创建。", z.object({ id: z.string(), title: z.string(), depends_on: z.array(z.string()) }),
      { id: string, title: string, depends_on: { type: "array", items: string } }, ["id", "title", "depends_on"],
      (input) => JSON.stringify(board.add(input.id, input.title, input.depends_on))),
    tool("task_claim", "领取依赖已完成的任务，返回版本。", z.object({ id: z.string(), owner: z.string() }),
      { id: string, owner: string }, ["id", "owner"], (input) => JSON.stringify(board.claim(input.id, input.owner))),
    tool("task_complete", "持领取版本完成任务。", z.object({ id: z.string(), owner: z.string(), version: z.number().int() }),
      { id: string, owner: string, version: { type: "integer" } }, ["id", "owner", "version"],
      (input) => JSON.stringify(board.complete(input.id, input.owner, input.version))),

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
      
      await compressWorkingHistory(messages, {
        model, modelName: MODEL, thresholdTokens: options.contextThreshold,
        signal: abort.signal, log,
      });
      const response = await model.create({
        model: MODEL, max_tokens: 4096,
        system: "你是 " + cwd + " 中的编程助手，回答用中文。执行持久任务前先领取，完成实际工作后用返回的 version 更新状态。",
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
  return { agentLoop, execute, messages, tools, close, board };
}
export async function demo() {

  const os = await import("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-course-"));
  try {
    const board = new TaskBoard(directory);
    board.add("build", "构建"); board.add("test", "测试", ["build"]);
    try { board.claim("test", "alice"); } catch (error) { console.log(String(error)); }
    const build = board.claim("build", "alice");
    board.complete("build", "alice", build.version);
    console.log(new TaskBoard(directory).claim("test", "bob"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }

}

export async function main() {
  if (process.argv.includes("--help")) {
    console.log("pnpm run example:17 -- --prompt \"创建 read-demo 任务，领取后读取 README.md，再完成任务。\"；不传 --prompt 进入交互终端。 --demo 是无需模型的机制演示，具体注入与协议范围见章节。");
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
  console.log("持久任务与依赖图。输入 q 或 exit 退出。");
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
