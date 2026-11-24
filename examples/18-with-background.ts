// 第 18 章：后台命令与通知。工具、状态和 agentLoop 都在本文件内。

import Anthropic from "@anthropic-ai/sdk";
import { compressWorkingHistory } from "./context";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

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

type Job = { id: string; status: "running" | "completed" | "failed" | "cancelled"; output: string; exitCode?: number | null; child: ChildProcess; done: Promise<void> };
export class BackgroundJobs {
  readonly jobs = new Map<string, Job>();
  readonly notices: string[] = [];
  constructor(readonly cwd: string) {}
  start(command: string) {
    const id = crypto.randomUUID();
    // 独立进程组允许取消 shell 派生的子进程（本课程运行于 macOS/Linux）。
    const child = spawn(command, { cwd: this.cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let resolve!: () => void;
    const done = new Promise<void>((finish) => { resolve = finish; });
    const job: Job = { id, status: "running", output: "", child, done };
    this.jobs.set(id, job);
    const collect = (chunk: Buffer) => { job.output = (job.output + chunk.toString()).slice(-12_000); };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    child.once("error", (error) => { job.output += "\n" + error.message; });
    child.once("close", (code) => {
      job.exitCode = code;
      if (job.status !== "cancelled") job.status = code === 0 ? "completed" : "failed";
      this.notices.push(JSON.stringify({ id, status: job.status, exitCode: code }));
      resolve();
    });
    return id;
  }
  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("未知后台任务");
    return { id, status: job.status, exitCode: job.exitCode, output: job.output };
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("未知后台任务");
    if (job.status !== "running") return this.get(id);
    job.status = "cancelled";
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && job.child.pid) process.kill(-job.child.pid, signal);
        else job.child.kill(signal);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 500);
    try { await job.done; } finally { clearTimeout(timer); }
    return this.get(id);
  }
  async waitAll() { await Promise.all([...this.jobs.values()].filter((job) => job.status === "running").map((job) => job.done)); }
  drain() { return this.notices.splice(0); }
  async close() { await Promise.all([...this.jobs.values()].filter((job) => job.status === "running").map((job) => this.cancel(job.id))); }
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
  const background = new BackgroundJobs(cwd);
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
    
    tool("background_start", "后台运行 shell 命令并立即返回 id。", z.object({ command: z.string().min(1) }),
      { command: string }, ["command"], (input) => background.start(input.command)),
    tool("background_status", "读取后台任务状态和实际输出。", z.object({ id: z.string() }),
      { id: string }, ["id"], (input) => JSON.stringify(background.get(input.id))),
    tool("background_cancel", "取消后台进程组。", z.object({ id: z.string() }), { id: string }, ["id"],
      async (input) => JSON.stringify(await background.cancel(input.id))),
    tool("background_wait", "等待目前的后台任务完成。", z.object({}), {}, [], async () => { await background.waitAll(); return "后台任务已结束"; }),

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
      const notices = background.drain(); if (notices.length) messages.push({ role: "user", content: "后台通知：" + notices.join("\n") });
      await compressWorkingHistory(messages, {
        model, modelName: MODEL, thresholdTokens: options.contextThreshold,
        signal: abort.signal, log,
      });
      const response = await model.create({
        model: MODEL, max_tokens: 4096,
        system: "你是 " + cwd + " 中的编程助手，回答用中文。长命令可以放到后台。任务结束前调用 background_wait，随后 status 查看真实输出。不得仅根据开始成功判断命令成功。",
        tools: tools.map((entry) => entry.definition), messages: structuredClone(messages),
      }, { signal: abort.signal });
      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      if (calls.length === 0) {
        if ([...background.jobs.values()].some((job) => job.status === "running")) {
          messages.push({ role: "user", content: "仍有后台任务运行；请等待结果或取消，再结束。" }); continue;
        }
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
  async function close() { abort.abort(); await background.close(); }
  return { agentLoop, execute, messages, tools, close, background };
}
export async function demo() {

  const jobs = new BackgroundJobs(process.cwd());
  try {
    const id = jobs.start("node -e 'console.log(42)'");
    await jobs.waitAll();
    console.log(jobs.get(id)); console.log(jobs.drain());
  } finally { await jobs.close(); }

}

export async function main() {
  if (process.argv.includes("--help")) {
    console.log("pnpm run example:18 -- --prompt \"后台执行 node -e 'console.log(42)'，等待结束并读取输出。\"；不传 --prompt 进入交互终端。 --demo 是无需模型的机制演示，具体注入与协议范围见章节。");
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
  console.log("后台命令与通知。输入 q 或 exit 退出。");
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
