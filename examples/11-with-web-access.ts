// 本示例聚焦于: 网络访问(第 11 章)。
// 包含: 工具(第 2 章)、编辑(第 3 章)、系统提示词(第 4 章)、流式(第 9 章)、并发(第 10 章)。
// 省略: 权限(第 7 章)、子代理(第 8 章)、压缩(第 6 章),让代码保持聚焦。

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";
import Turndown from "turndown";

const client = new Anthropic();

// 主循环用的模型；FAST_MODEL 给子任务（网页摘要）用，默认可以是更便宜的小模型。
// 两者都可以通过 .env 覆盖。
const MODEL = process.env.MODEL ?? "trae-internal/openrouter-3o";
const FAST_MODEL = process.env.FAST_MODEL ?? MODEL;

const SYSTEM_PROMPT = `你是一个编程助手。你可以读取、搜索和编辑本地文件。你还可以抓取网页来查阅文档或参考资料。

# 如何工作
- 编辑前先用 list_files 和 search_files 找到相关的本地文件。
- 编辑前永远先读文件。
- 用 web_fetch 在线查阅文档、API 参考或报错的解决方案。
- 保持简洁。`;

// --- 类型 ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  isConcurrencySafe: boolean;
  call(input: Record<string, unknown>): Promise<string>;
}

const readTimestamps = new Map<string, number>();
const MAX_RESULT_CHARS = 10_000;
const MAX_WEB_CONTENT = 50_000;

function truncateResult(r: string): string {
  return r.length <= MAX_RESULT_CHARS ? r : r.slice(0, MAX_RESULT_CHARS) + "\n[Truncated]";
}

function findActualString(fc: string, ss: string): string | null {
  if (fc.includes(ss)) return ss;
  const n = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const i = n(fc).indexOf(n(ss));
  return i !== -1 ? fc.substring(i, i + ss.length) : null;
}

function zodToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const zv = value as z.ZodTypeAny;
    const opt = zv.isOptional();
    const inner = opt ? (zv as z.ZodOptional<any>)._def.innerType : zv;
    const isBoolean = inner instanceof z.ZodBoolean;
    properties[key] = { type: isBoolean ? "boolean" : "string", description: inner._def.description || "" };
    if (!opt) required.push(key);
  }
  return { type: "object", properties, required };
}

// --- URL 缓存 ---
const urlCache = new Map<string, string>();

// --- 用 Turndown 把 HTML 转成 Markdown ---
const turndown = new Turndown();

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

// --- 工具 ---
const tools: Tool[] = [
  {
    name: "read_file",
    description: "读取文件,带行号。",
    inputSchema: z.object({ file_path: z.string() }),
    isConcurrencySafe: true,
    async call(input) {
      const fp = input.file_path as string;
      try {
        const c = fs.readFileSync(fp, "utf-8");
        readTimestamps.set(path.resolve(fp), Date.now());
        return truncateResult(c.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"));
      } catch (e: any) { return `Error: ${e.message}`; }
    },
  },
  {
    name: "edit_file",
    description: "编辑文件,用 new_string 替换 old_string。请先读取文件。",
    inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
    isConcurrencySafe: false,
    async call(input) {
      const { file_path: fp, old_string: os, new_string: ns, replace_all: ra } = input as any;
      if (os === ns) return "Error: identical.";
      if (!fs.existsSync(fp)) return "Error: not found.";
      const c = fs.readFileSync(fp, "utf-8");
      const a = findActualString(c, os);
      if (!a) return "Error: not found in file.";
      if (!ra && c.split(a).length - 1 > 1) return "Error: multiple matches.";
      const u = ra ? c.split(a).join(ns) : c.replace(a, () => ns);
      fs.writeFileSync(fp, u);
      readTimestamps.set(path.resolve(fp), Date.now());
      return `Edited ${fp}`;
    },
  },
  {
    name: "write_file",
    description: "创建或覆盖文件。",
    inputSchema: z.object({ file_path: z.string(), content: z.string() }),
    isConcurrencySafe: false,
    async call(input) {
      const fp = input.file_path as string;
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, input.content as string);
      return `Written: ${fp}`;
    },
  },
  {
    name: "list_files",
    description: "递归列出文件。",
    inputSchema: z.object({ directory: z.string().optional() }),
    isConcurrencySafe: true,
    async call(input) {
      const dir = (input.directory as string) || ".";
      const files: string[] = [];
      function walk(d: string) {
        try {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue;
            const f = path.join(d, e.name);
            if (e.isDirectory()) walk(f); else files.push(f);
          }
        } catch {}
      }
      walk(dir);
      return files.join("\n") || "(empty)";
    },
  },
  {
    name: "search_files",
    description: "在文件中搜索正则表达式模式。",
    inputSchema: z.object({ pattern: z.string(), directory: z.string().optional() }),
    isConcurrencySafe: true,
    async call(input) {
      const dir = (input.directory as string) || ".";
      let rx: RegExp;
      try { rx = new RegExp(input.pattern as string); }
      catch { return "Error: Invalid regex pattern."; }
      const res: string[] = [];
      function s(d: string) {
        try {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue;
            const f = path.join(d, e.name);
            if (e.isDirectory()) { s(f); } else {
              try { fs.readFileSync(f, "utf-8").split("\n").forEach((l, i) => {
                if (rx.test(l)) res.push(`${f}:${i + 1}: ${l.trim()}`);
              }); } catch {}
            }
          }
        } catch {}
      }
      s(dir);
      return truncateResult(res.slice(0, 50).join("\n") || "No matches.");
    },
  },
  {
    name: "run_command",
    description: "执行一条 shell 命令。",
    inputSchema: z.object({ command: z.string() }),
    isConcurrencySafe: false,
    async call(input) {
      try {
        return truncateResult(execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 }) || "(no output)");
      } catch (e: any) { return `Error: ${e.stderr || e.message}`; }
    },
  },

  // --- 网页抓取工具(本章新增) ---
  {
    name: "web_fetch",
    description:
      "抓取一个网页并返回它的文本内容。" +
      "用它来查阅文档、API 参考或报错的解决方案。",
    inputSchema: z.object({
      url: z.string().describe("要抓取的 URL"),
      prompt: z.string().describe("要从页面中提取或聚焦的内容"),
    }),
    isConcurrencySafe: true, // 抓取是只读操作
    async call(input) {
      const url = input.url as string;
      const prompt = input.prompt as string;

      // 检查缓存
      const cacheKey = `${url}::${prompt}`;
      const cached = urlCache.get(cacheKey);
      if (cached) {
        console.log(`  [缓存命中] ${url}`);
        return cached;
      }

      // 抓取页面
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; CodingAgent/1.0)" },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          return `Error: HTTP ${response.status} ${response.statusText}`;
        }

        const html = await response.text();
        const markdown = htmlToMarkdown(html);

        // 过长则截断
        const truncated = markdown.length > MAX_WEB_CONTENT
          ? markdown.slice(0, MAX_WEB_CONTENT) + "\n\n[Content truncated]"
          : markdown;

        // 用一个辅助模型提取相关内容
        console.log(`  [提取中] 对 ${markdown.length} 字符应用 prompt...`);
        const extraction = await client.messages.create({
          model: FAST_MODEL,
          max_tokens: 2048,
          system: "你是一个内容提取器。给定一个网页和一个 prompt,只提取相关的信息。保持简洁、聚焦。如果页面不包含相关信息,就直接说明。",
          messages: [{
            role: "user",
            content: `Prompt: ${prompt}\n\n页面内容(来自 ${url}):\n${truncated}`,
          }],
        });

        const result = extraction.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        // 缓存结果
        urlCache.set(cacheKey, result);
        return result;

      } catch (e: any) {
        if (e.name === "TimeoutError") {
          return `Error: Request timed out after 15 seconds for ${url}`;
        }
        return `Error fetching ${url}: ${e.message}`;
      }
    },
  },

  // --- 网页搜索工具(本章新增) ---
  // 使用 Anthropic 内置的服务端网页搜索。
  // 搜索在 Anthropic 的服务器上进行。无需外部 API key。
  {
    name: "web_search",
    description:
      "搜索网络并返回带标题和 URL 的结果。" +
      "用它来在线查找文档、解决方案或参考资料。",
    inputSchema: z.object({
      query: z.string().describe("搜索查询"),
    }),
    isConcurrencySafe: true,
    async call(input) {
      const query = input.query as string;

      try {
        // 另发一次带服务端网页搜索工具的 API 调用
        const response = await client.messages.create({
          model: FAST_MODEL,
          max_tokens: 1024,
          system: "执行网络搜索并返回结果。",
          tools: [
            { type: "web_search_20250305", name: "web_search", max_uses: 5 } as any,
          ],
          messages: [
            { role: "user", content: `在网络上搜索: ${query}` },
          ],
        });

        // 只有服务端搜索结果块才是搜索证据；普通文本不能证明搜索实际发生。
        const parts: string[] = [];
        let hasSearchResult = false;
        for (const block of response.content) {
          if ((block as any).type === "web_search_tool_result") {
            hasSearchResult = true;
            const content = (block as any).content;
            if (Array.isArray(content)) {
              for (const result of content) {
                parts.push(`- ${result.title}: ${result.url}`);
              }
            } else {
              return `Error: 服务端搜索失败：${content?.error_code ?? "未知错误"}`;
            }
          }
        }

        if (!hasSearchResult) return "Error: 当前模型或网关未返回服务端搜索结果，无法确认搜索发生。请使用支持 Anthropic web_search 的模型，或用 web_fetch 读取已知 URL。";
        return parts.join("\n") || "No results found.";
      } catch (e: any) {
        return `Error searching: ${e.message}`;
      }
    },
  },
];

const apiTools: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: zodToJsonSchema(t.inputSchema) as Anthropic.Tool["input_schema"],
}));

// --- 流式智能体循环(来自第 9 章,并带第 10 章的并发) ---

interface ToolCall {
  block: Anthropic.ToolUseBlock;
  tool: Tool;
  input: Record<string, unknown>;
}

interface Batch {
  calls: ToolCall[];
  concurrent: boolean;
}

function partitionIntoBatches(toolCalls: ToolCall[]): Batch[] {
  const batches: Batch[] = [];
  let currentCalls: ToolCall[] = [];
  let currentConcurrent = true;
  for (const call of toolCalls) {
    if (call.tool.isConcurrencySafe && currentConcurrent) {
      currentCalls.push(call);
    } else {
      if (currentCalls.length > 0) batches.push({ calls: currentCalls, concurrent: currentConcurrent });
      currentCalls = [call];
      currentConcurrent = call.tool.isConcurrencySafe;
    }
  }
  if (currentCalls.length > 0) batches.push({ calls: currentCalls, concurrent: currentConcurrent });
  return batches;
}

async function executeToolCall(call: ToolCall): Promise<Anthropic.ToolResultBlockParam> {
  try {
    const result = await call.tool.call(call.input);
    return { type: "tool_result", tool_use_id: call.block.id, content: result };
  } catch (err: any) {
    return { type: "tool_result", tool_use_id: call.block.id, content: `Error: ${err.message}`, is_error: true };
  }
}

async function executeBatches(batches: Batch[]): Promise<Anthropic.ToolResultBlockParam[]> {
  const allResults: Anthropic.ToolResultBlockParam[] = [];
  for (const batch of batches) {
    if (batch.concurrent && batch.calls.length > 1) {
      console.log(`  [批次] ${batch.calls.length} 个工具并发`);
      const results = await Promise.all(batch.calls.map(executeToolCall));
      allResults.push(...results);
    } else {
      for (const call of batch.calls) {
        console.log(`  [工具] ${call.tool.name}(${JSON.stringify(call.block.input).slice(0, 80)})`);
        const result = await executeToolCall(call);
        const content = typeof result.content === "string" ? result.content : "";
        console.log(`  [结果] ${content.slice(0, 150)}${content.length > 150 ? "..." : ""}`);
        allResults.push(result);
      }
    }
  }
  return allResults;
}

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  let turns = 0;
  const maxTurns = 20;

  while (true) {
    turns++;
    if (turns > maxTurns) return "[max turns reached]";

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: apiTools,
      messages,
    });

    const contentBlocks: any[] = [];
    let currentBlockType: string | null = null;
    let currentToolInput = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentTextIndex = -1;

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "text") {
            currentBlockType = "text";
            currentTextIndex = contentBlocks.length;
            contentBlocks.push({ type: "text", text: "" });
          } else if (event.content_block.type === "tool_use") {
            currentBlockType = "tool_use";
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInput = "";
          }
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            process.stdout.write(event.delta.text);
            if (currentTextIndex >= 0) contentBlocks[currentTextIndex].text += event.delta.text;
          } else if (event.delta.type === "input_json_delta") {
            currentToolInput += event.delta.partial_json;
          }
          break;
        case "content_block_stop":
          if (currentBlockType === "tool_use") {
            try {
              contentBlocks.push({ type: "tool_use", id: currentToolId, name: currentToolName, input: currentToolInput ? JSON.parse(currentToolInput) : {} });
            } catch {
              contentBlocks.push({ type: "tool_use", id: currentToolId, name: currentToolName, input: {} });
            }
            currentToolInput = "";
          }
          currentBlockType = null;
          break;
      }
    }

    messages.push({ role: "assistant", content: contentBlocks });

    const toolBlocks = contentBlocks.filter((b: any) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    if (toolBlocks.length === 0) {
      process.stdout.write("\n");
      return contentBlocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    }

    const toolCalls: ToolCall[] = toolBlocks.map(block => {
      const tool = tools.find(t => t.name === block.name);
      return { block, tool: tool!, input: block.input as Record<string, unknown> };
    });

    const batches = partitionIntoBatches(toolCalls);
    const toolResults = await executeBatches(batches);
    messages.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("带网络访问的智能体。试试:");
  console.log('  "抓取 https://example.com 并告诉我它写了什么"');
  console.log('  "在网上搜索如何使用 React useEffect"');
  console.log('  "Anthropic 文档首页上有什么?"\n');

  const ask = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();
      conversationHistory.push({ role: "user", content: trimmed });
      console.log("");
      await agentLoop(conversationHistory);
      console.log("");
      ask();
    });
  };
  ask();
}

main();
