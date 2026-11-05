// 第 21 章：通过 MCP 发现外部工具。工具、状态和 agentLoop 都在本文件内。

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

export class McpConnection {
  readonly client = new Client({ name: "coding-course", version: "1.0.0" });
  readonly transport: StdioClientTransport;
  constructor(serverFile: string) {
    this.transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", serverFile], stderr: "pipe" });
  }
  async connect() {
    try {
      await this.client.connect(this.transport);
      const result = await this.client.listTools();
      // 将外部工具加前缀，避免覆盖 read_file 等本地工具。
      return result.tools.map((entry): Tool => ({
        definition: { name: "mcp_" + entry.name, description: entry.description,
          input_schema: entry.inputSchema as Anthropic.Tool.InputSchema },
        schema: z.record(z.unknown()),
        call: async (input) => {
          const response = await this.client.callTool({ name: entry.name, arguments: input }, undefined, { timeout: 10_000 });
          const text = Array.isArray(response.content) ? response.content.map((item: any) => item.type === "text" ? item.text : JSON.stringify(item)).join("\n") : JSON.stringify(response);
          return response.isError ? "Error: " + text : text;
        },
      }));
    } catch (error) { await this.client.close(); throw error; }
  }
  async close() { await this.client.close(); }
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
  
  const serverFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-demo-server.ts");
  const mcp = new McpConnection(serverFile);
  const externalTools = await mcp.connect();
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
    ...externalTools,
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
        system: "你是 " + cwd + " 中的编程助手，回答用中文。mcp_ 前缀工具来自外部 MCP 服务，工具返回错误时应修正输入；不能把服务声明当作已执行证据。",
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
  async function close() { abort.abort(); await mcp.close(); }
  return { agentLoop, execute, messages, tools, close, mcp };
}
export async function demo() {

  const serverFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-demo-server.ts");
  const connection = new McpConnection(serverFile);
  try {
    const tools = await connection.connect();
    console.log("发现", tools.map((entry) => entry.definition.name));
    console.log(await tools.find((entry) => entry.definition.name === "mcp_add")!.call({ a: 20, b: 22 }));
  } finally { await connection.close(); }

}

export async function main() {
  if (process.argv.includes("--help")) {
    console.log("pnpm run example:21 -- --prompt \"用 mcp_echo 回显 MCP_READY，再用 mcp_add 计算 20 加 22。\"；不传 --prompt 进入交互终端。 --demo 是无需模型的机制演示，具体注入与协议范围见章节。");
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
  console.log("通过 MCP 发现外部工具。输入 q 或 exit 退出。");
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
