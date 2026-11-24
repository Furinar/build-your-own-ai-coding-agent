// 第 20 章：团队消息、审批与 Worktree。工具、状态和 agentLoop 都在本文件内。

import Anthropic from "@anthropic-ai/sdk";
import { compressWorkingHistory } from "./context";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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

const MailSchema = z.object({
  id: z.string(), from: z.string(), to: z.string(), kind: z.enum(["note", "request", "approval"]),
  text: z.string(), taskId: z.string().optional(), version: z.number().optional(), acknowledged: z.boolean(),
});
export class TeamMailbox {
  readonly file: string;
  constructor(readonly directory: string) { fs.mkdirSync(directory, { recursive: true }); this.file = path.join(directory, "mail.json"); }
  all() { return fs.existsSync(this.file) ? z.array(MailSchema).parse(JSON.parse(fs.readFileSync(this.file, "utf8"))) : []; }
  transaction<T>(operation: (mail: z.infer<typeof MailSchema>[]) => T): T {
    const lock = this.file + ".lock";
    try { fs.mkdirSync(lock); } catch { throw new Error("消息文件忙"); }
    try { const mail = this.all(); const result = operation(mail); atomicWrite(this.file, mail); return result; }
    finally { fs.rmdirSync(lock); }
  }
  send(from: string, to: string, text: string, kind: "note" | "request" | "approval" = "note", taskId?: string, version?: number) {
    if (!from.trim() || !to.trim() || !text.trim()) throw new Error("消息字段不能为空");
    return this.transaction((mail) => {
      const message = MailSchema.parse({ id: crypto.randomUUID(), from, to, text, kind, taskId, version, acknowledged: false });
      mail.push(message); return message;
    });
  }
  inbox(member: string) { return this.all().filter((message) => message.to === member && !message.acknowledged); }
  acknowledge(member: string, id: string) {
    return this.transaction((mail) => {
      const message = mail.find((item) => item.id === id && item.to === member);
      if (!message) throw new Error("没有这条收件消息");
      message.acknowledged = true; return message;
    });
  }
  approved(task: Task, reviewer: string) {
    return reviewer !== task.owner && this.all().some((message) => message.kind === "approval"
      && message.from === reviewer && message.to === task.owner && message.taskId === task.id && message.version === task.version);
  }
}
export class Worktrees {
  constructor(readonly repository: string) {}
  create(member: string) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(member)) throw new Error("成员名只能包含字母、数字、下划线和短横线");
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: this.repository });
    const directory = path.join(this.repository, ".worktrees", member);
    if (fs.existsSync(directory)) throw new Error("成员工作目录已存在");
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    // detached 工作树不碰当前分支；这里不创建提交或执行合并。
    execFileSync("git", ["worktree", "add", "--detach", directory, "HEAD"], { cwd: this.repository, stdio: "pipe" });
    return directory;
  }
  run(member: string, args: string[]) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(member)) throw new Error("成员名无效");
    const directory = path.join(this.repository, ".worktrees", member);
    if (!fs.existsSync(path.join(directory, ".git"))) throw new Error("先创建成员 worktree");
    // 同一仓库中的其他位置不能借此执行任意命令：本工具只提供 git status/diff。
    if (!["status", "diff"].includes(args[0]) || args.length !== 1) throw new Error("仅支持 git status 或 diff");
    return execFileSync("git", args, { cwd: directory, encoding: "utf8" });
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
  
  const member = process.env.TEAM_MEMBER?.trim() || "coordinator";
  const board = new TaskBoard(path.join(cwd, ".team", "tasks"));
  const mailbox = new TeamMailbox(path.join(cwd, ".team"));
  const worktrees = new Worktrees(cwd);
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
    
    tool("team_send", "以当前成员身份发送消息。", z.object({ to: z.string(), text: z.string() }),
      { to: string, text: string }, ["to", "text"], (input) => JSON.stringify(mailbox.send(member, input.to, input.text))),
    tool("team_inbox", "读取未确认消息；读取本身不会删除。", z.object({}), {}, [], () => JSON.stringify(mailbox.inbox(member))),
    tool("team_ack", "处理消息后确认。", z.object({ id: z.string() }), { id: string }, ["id"],
      (input) => JSON.stringify(mailbox.acknowledge(member, input.id))),
    tool("task_create", "创建待协作任务。", z.object({ id: z.string(), title: z.string(), depends_on: z.array(z.string()) }),
      { id: string, title: string, depends_on: { type: "array", items: string } }, ["id", "title", "depends_on"],
      (input) => JSON.stringify(board.add(input.id, input.title, input.depends_on))),
    tool("task_list", "查看团队任务。", z.object({}), {}, [], () => JSON.stringify(board.snapshot())),
    tool("task_claim", "以当前成员身份领取。", z.object({ id: z.string() }), { id: string }, ["id"],
      (input) => JSON.stringify(board.claim(input.id, member))),
    tool("review_request", "请求其他成员审查当前领取版本。", z.object({ id: z.string(), reviewer: z.string() }),
      { id: string, reviewer: string }, ["id", "reviewer"], (input) => {
        const task = board.snapshot().find((item) => item.id === input.id);
        if (!task || task.status !== "running" || task.owner !== member || member === input.reviewer) throw new Error("只可请求他人审查本人运行中的任务");
        return JSON.stringify(mailbox.send(member, input.reviewer, "请审查任务", "request", task.id, task.version));
      }),
    tool("review_approve", "当前成员确认审查请求；批准绑定当前任务版本。", z.object({ request_id: z.string() }),
      { request_id: string }, ["request_id"], (input) => {
        const request = mailbox.inbox(member).find((item) => item.id === input.request_id && item.kind === "request");
        const task = board.snapshot().find((item) => item.id === request?.taskId);
        if (!request || !task || task.status !== "running" || task.owner !== request.from || task.version !== request.version || member === task.owner) throw new Error("请求过期或不可自我批准");
        return JSON.stringify(mailbox.send(member, task.owner!, "审查通过", "approval", task.id, task.version));
      }),
    tool("task_complete", "批准版本一致后才能完成任务。", z.object({ id: z.string(), version: z.number().int(), reviewer: z.string() }),
      { id: string, version: { type: "integer" }, reviewer: string }, ["id", "version", "reviewer"], (input) => {
        const task = board.snapshot().find((item) => item.id === input.id);
        if (!task || !mailbox.approved(task, input.reviewer)) throw new Error("尚无匹配当前版本的他人批准");
        return JSON.stringify(board.complete(input.id, member, input.version));
      }),
    tool("worktree_create", "为当前成员创建独立 detached 工作树。", z.object({}), {}, [], () => worktrees.create(member)),
    tool("worktree_status", "在当前成员工作树内执行 git status。", z.object({}), {}, [], () => worktrees.run(member, ["status"])),

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
        system: "你是 " + cwd + " 中的编程助手，回答用中文。消息投递不会启动另一个 Agent；需在另一个终端以 TEAM_MEMBER 指定成员启动。worktree_create 后另开终端进入返回目录再运行编程任务。",
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
  return { agentLoop, execute, messages, tools, close, member, board, mailbox, worktrees };
}
export async function demo() {

  const os = await import("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-course-"));
  try {
    const board = new TaskBoard(path.join(directory, "tasks")); const mailbox = new TeamMailbox(directory);
    board.add("review", "审查例子"); const task = board.claim("review", "alice");
    const request = mailbox.send("alice", "bob", "请审查", "request", task.id, task.version);
    console.log(new TeamMailbox(directory).inbox("bob"));
    mailbox.send("bob", "alice", "通过", "approval", task.id, task.version);
    console.log("当前版本批准", mailbox.approved(task, "bob"), "旧版本批准", mailbox.approved({ ...task, version: task.version + 1 }, "bob"));
    mailbox.acknowledge("bob", request.id);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }

}

export async function main() {
  if (process.argv.includes("--help")) {
    console.log("pnpm run example:20 -- --prompt \"查看团队任务和我的收件箱。\"；不传 --prompt 进入交互终端。 --demo 是无需模型的机制演示，具体注入与协议范围见章节。");
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
  console.log("团队消息、审批与 Worktree。输入 q 或 exit 退出。");
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
