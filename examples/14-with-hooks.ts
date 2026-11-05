// 第 14 章：给可见的 agentLoop 加上扩展点。
// 只保留读写文件两个工具，让你能在一个文件里看清 Hook 的位置。
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type Message = Anthropic.MessageParam;
export interface Model {
  create(request: { model: string; max_tokens: number; system: string; tools: Anthropic.Tool[]; messages: Message[] },
    options?: { signal?: AbortSignal }): Promise<Pick<Anthropic.Message, "content">>;
}
interface Tool {
  definition: Anthropic.Tool;
  schema: z.ZodType;
  call(input: any): Promise<string> | string;
}
export type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
export interface HookContext { query?: string; name?: string; input?: unknown; output?: string; messages: Message[] }
export type Hook = (context: HookContext) => string | void | Promise<string | void>;

// 返回字符串的含义由触发点决定：PreToolUse 用它拒绝，Stop 用它要求继续。
export async function trigger(hooks: Map<HookEvent, Hook[]>, event: HookEvent, context: HookContext) {
  for (const hook of hooks.get(event) ?? []) {
    const result = await hook(context);
    if (typeof result === "string" && result.trim()) return result;
  }
}
export function createAgent(options: { cwd?: string; model?: Model; maxTurns?: number; log?: (text: string) => void } = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const MODEL = process.env.MODEL?.trim() || "trae-internal/openrouter-3o";
  let client: Anthropic | undefined;
  const model: Model = options.model ?? { create: (request, opts) => {
    client ??= new Anthropic({ timeout: 120_000, maxRetries: 0 });
    return client.messages.create(request, opts);
  } };
  const log = options.log ?? console.log;
  const abort = new AbortController();
  const hooks = new Map<HookEvent, Hook[]>();
  const messages: Message[] = [];
  const tools: Tool[] = [
    {
      definition: { name: "read_file", description: "读取 UTF-8 文本文件。",
        input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
      schema: z.object({ file_path: z.string() }),
      call: (input) => fs.readFileSync(path.resolve(cwd, input.file_path), "utf8"),
    },
    {
      definition: { name: "write_file", description: "创建或覆盖 UTF-8 文本文件。",
        input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
      schema: z.object({ file_path: z.string(), content: z.string() }),
      call(input) {
        const file = path.resolve(cwd, input.file_path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, input.content, "utf8");
        return `已写入 ${input.file_path}`;
      },
    },
  ];
  const on = (event: HookEvent, hook: Hook) => hooks.set(event, [...(hooks.get(event) ?? []), hook]);
  // 权限在工具执行入口检查；这是本章展示的简单规则，不是操作系统沙箱。
  on("PreToolUse", ({ name, input }) => {
    if (name !== "write_file") return;
    const parsed = z.object({ file_path: z.string() }).safeParse(input);
    if (parsed.success && path.basename(parsed.data.file_path).startsWith(".env")) return "本示例不写入凭据文件。";
  });
  on("PostToolUse", ({ name, output }) => { log(`[结果] ${name}: ${output?.slice(0, 100)}`); });

  async function execute(block: Anthropic.ToolUseBlock): Promise<string> {
    try {
      abort.signal.throwIfAborted();
      const context = { name: block.name, input: block.input, messages };
      const reason = await trigger(hooks, "PreToolUse", context);
      if (reason) return `Error: ${reason}`;
      const tool = tools.find((candidate) => candidate.definition.name === block.name);
      if (!tool) return `Error: 未知工具 ${block.name}`;
      const parsed = tool.schema.safeParse(block.input);
      if (!parsed.success) return `Error: ${parsed.error.message}`;
      const output = await tool.call(parsed.data);
      await trigger(hooks, "PostToolUse", { ...context, output });
      return output;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  // 核心循环就放在本文件：保存请求，执行工具，再配对回传结果。
  async function agentLoop(query: string): Promise<string> {
    await trigger(hooks, "UserPromptSubmit", { query, messages });
    messages.push({ role: "user", content: query });
    for (let turn = 0; turn < (options.maxTurns ?? 20); turn++) {
      abort.signal.throwIfAborted();
      const response = await model.create({
        model: MODEL, max_tokens: 4096,
        system: `你是 ${cwd} 中的编程助手，使用工具完成任务，回答用中文。`,
        tools: tools.map((tool) => tool.definition), messages: structuredClone(messages),
      }, { signal: abort.signal });
      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      if (calls.length === 0) {
        const continuation = await trigger(hooks, "Stop", { messages });
        if (continuation) { messages.push({ role: "user", content: continuation }); continue; }
        return response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of calls) {
        log(`[工具] ${block.name}`);
        const output = await execute(block);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output, is_error: output.startsWith("Error:") });
      }
      messages.push({ role: "user", content: results });
    }
    return "[已达到轮次上限]";
  }
  return { agentLoop, execute, on, hooks, messages, tools, close: () => abort.abort() };
}
export async function main() {
  const agent = createAgent();
  if (process.argv.includes("--help")) {
    console.log('pnpm run example:14 -- --prompt "读取 README.md"；不传 --prompt 则进入交互终端。');
    return;
  }
  const index = process.argv.indexOf("--prompt");
  if (index >= 0) {
    try { console.log(await agent.agentLoop(process.argv[index + 1] ?? "")); }
    finally { agent.close(); }
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stop = () => { agent.close(); rl.close(); };
  process.once("SIGINT", stop);
  console.log("Hook 示例。输入 q 或 exit 退出。");
  try {
    for await (const input of rl) {
      if (/^(q|exit)$/i.test(input.trim())) break;
      if (!input.trim()) continue;
      try { console.log(await agent.agentLoop(input)); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    }
  } finally { process.off("SIGINT", stop); rl.close(); agent.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
