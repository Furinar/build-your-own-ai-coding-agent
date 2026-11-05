// 第 19 章：定时任务与成功确认。工具、状态和 agentLoop 都在本文件内。

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { CronExpressionParser } from "cron-parser";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

const ScheduleSchema = z.object({
  id: z.string(), expression: z.string(), command: z.string(), nextDue: z.number(),
  remaining: z.number().int().nonnegative(), lastError: z.string().optional(),
});
export class CronJobs {
  readonly file: string;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<string[]>;
  readonly notices: string[] = [];
  constructor(readonly directory: string) { fs.mkdirSync(directory, { recursive: true }); this.file = path.join(directory, "cron.json"); }
  list() { return fs.existsSync(this.file) ? z.array(ScheduleSchema).parse(JSON.parse(fs.readFileSync(this.file, "utf8"))) : []; }
  next(expression: string, now: number) { return CronExpressionParser.parse(expression, { currentDate: new Date(now), tz: "UTC" }).next().getTime(); }
  locked<T>(operation: () => T): T {
    const lock = this.file + ".lock";
    try { fs.mkdirSync(lock); } catch { throw new Error("定时任务正被其他进程更新"); }
    try { return operation(); } finally { fs.rmdirSync(lock); }
  }
  create(expression: string, command: string, count: number, now = Date.now()) {
    if (!command.trim() || !Number.isInteger(count) || count < 1 || count > 10) throw new Error("命令不能为空，次数必须为 1..10");
    const nextDue = this.next(expression, now);
    return this.locked(() => {
      const jobs = this.list();
      if (jobs.filter((job) => job.remaining > 0).length >= 5) throw new Error("最多五个活动定时任务");
      const job = { id: crypto.randomUUID(), expression, command, nextDue, remaining: count };
      jobs.push(job); atomicWrite(this.file, jobs); return job;
    });
  }
  tick(now: number, execute: (command: string, key: string) => Promise<void>): Promise<string[]> {
    if (this.inFlight) return this.inFlight;
    const work = async () => {
      const lock = this.file + ".lock";
      try { fs.mkdirSync(lock); } catch { return ["定时任务忙，本次跳过"]; }
      try {
        const jobs = this.list(); const events: string[] = [];
        for (const job of jobs.filter((item) => item.remaining > 0 && item.nextDue <= now)) {
          const key = job.id + ":" + job.nextDue;
          try {
            await execute(job.command, key);
            // 只有执行成功才确认这一时刻；失败保留 nextDue，下一次 tick 重试。
            job.remaining--; job.nextDue = this.next(job.expression, now); delete job.lastError;
            events.push("已完成 " + key);
          } catch (error) {
            job.lastError = error instanceof Error ? error.message : String(error);
            events.push("失败，待重试 " + key + ": " + job.lastError);
          }
          atomicWrite(this.file, jobs);
        }
        return events;
      } finally { fs.rmdirSync(lock); }
    };
    this.inFlight = work().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  start(execute: (command: string, key: string) => Promise<void>) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(Date.now(), execute).then((events) => this.notices.push(...events)).catch((error) => this.notices.push(String(error))); }, 1000);
    this.timer.unref();
  }
  async close() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.inFlight; }
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
  
  const cron = new CronJobs(path.join(cwd, ".runtime"));
  const runScheduled = async (command: string, key: string) => {
    const result = await promisify(execFile)("/bin/sh", ["-c", command], {
      cwd, timeout: 10_000, maxBuffer: 64_000, signal: abort.signal,
      env: { ...process.env, CRON_RUN_KEY: key },
    });
    log("[定时输出] " + result.stdout.slice(-2000));
  };
  cron.start(runScheduled);
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
    
    tool("cron_create", "创建 UTC cron 定时命令，必须限制执行次数。", z.object({ expression: z.string(), command: z.string(), count: z.number().int().min(1).max(10) }),
      { expression: string, command: string, count: { type: "integer", minimum: 1, maximum: 10 } }, ["expression", "command", "count"],
      (input) => JSON.stringify(cron.create(input.expression, input.command, input.count))),
    tool("cron_list", "查看到期时间、剩余次数与最后错误。", z.object({}), {}, [], () => JSON.stringify(cron.list())),
    tool("cron_tick", "执行目前已到期的命令并返回真实结果。", z.object({}), {}, [], async () => JSON.stringify(await cron.tick(Date.now(), runScheduled))),

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
      if (cron.notices.length) messages.push({ role: "user", content: "定时通知：" + cron.notices.splice(0).join("\n") });
      const response = await model.create({
        model: MODEL, max_tokens: 4096,
        system: "你是 " + cwd + " 中的编程助手，回答用中文。cron 使用 UTC；只有 CLI 存活时自动检查。不得把已创建计划说成已执行成功。",
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
  async function close() { abort.abort(); await cron.close(); }
  return { agentLoop, execute, messages, tools, close, cron };
}
export async function demo() {

  const os = await import("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cron-course-"));
  const cron = new CronJobs(directory);
  try {
    const job = cron.create("*/1 * * * * *", "demo", 1, 0);
    console.log(await cron.tick(job.nextDue, async () => { throw new Error("模拟失败"); }));
    console.log("失败后仍待执行", cron.list());
    const restored = new CronJobs(directory);
    console.log(await restored.tick(job.nextDue, async (_command, key) => { console.log("执行", key); }));
    console.log(restored.list());
  } finally { await cron.close(); fs.rmSync(directory, { recursive: true, force: true }); }

}

export async function main() {
  if (process.argv.includes("--help")) {
    console.log("pnpm run example:19 -- --prompt \"查看已有定时任务，解释下一次到期时间。\"；不传 --prompt 进入交互终端。 --demo 是无需模型的机制演示，具体注入与协议范围见章节。");
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
  console.log("定时任务与成功确认。输入 q 或 exit 退出。");
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
