// 第 15 章：待办管理。工具、状态和 agentLoop 都在本文件内。

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

export const TodoSchema = z.array(z.object({
  id: z.string().min(1), content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
})).max(20);
export class TodoList {
  items: z.infer<typeof TodoSchema> = [];
  replace(value: unknown) {
    const next = TodoSchema.parse(value);
    if (new Set(next.map((item) => item.id)).size !== next.length) throw new Error("待办 id 必须唯一");
    if (next.filter((item) => item.status === "in_progress").length > 1) throw new Error("同时只能有一个进行中的待办");
    // 已完成项必须保留；不能靠删掉未完成项绕过停止检查。
    for (const previous of this.items) {
      const item = next.find((candidate) => candidate.id === previous.id);
      if (!item) throw new Error("不能删除已有待办；请完成它");
      if (previous.status === "completed" && item.status !== "completed") throw new Error("已完成项不能倒退");
    }
    this.items = next;
    return JSON.stringify(this.items);
  }
  pending() { return this.items.filter((item) => item.status !== "completed"); }
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
  const todos = new TodoList();
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
    
    tool("todo_write", "更新完整待办清单，最多一个进行中项目。", z.object({ items: TodoSchema }),
      { items: { type: "array", items: { type: "object", properties: { id: string, content: string,
        status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["id", "content", "status"] } } },
      ["items"], (input) => todos.replace(input.items)),
    tool("todo_read", "查看待办清单。", z.object({}), {}, [], () => JSON.stringify(todos.items)),

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
        system: "你是 " + cwd + " 中的编程助手，回答用中文。复杂任务先列待办，开始一项时标为 in_progress，完成后标为 completed。",
        tools: tools.map((entry) => entry.definition), messages: structuredClone(messages),
      }, { signal: abort.signal });
      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      if (calls.length === 0) {
        if (todos.pending().length) {
          messages.push({ role: "user", content: "仍有未完成待办，请继续或说明阻塞原因：" + JSON.stringify(todos.pending()) });
          continue;
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
  async function close() { abort.abort();  }
  return { agentLoop, execute, messages, tools, close, todos };
}

export async function main() {
  if (process.argv.includes("--help")) {
    console.log("pnpm run example:15 -- --prompt \"创建一个读取 README.md 的待办，执行并更新为已完成。\"；不传 --prompt 进入交互终端。");
    return;
  }
  
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
  console.log("待办管理。输入 q 或 exit 退出。");
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
