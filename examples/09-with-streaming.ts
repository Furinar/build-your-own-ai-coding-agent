// 本示例聚焦于: 流式(第 9 章)。
// 包含: 工具(第 2 章)、编辑(第 3 章)、系统提示词(第 4 章)、上下文(第 5 章)、压缩(第 6 章)。
// 省略: 权限(第 7 章)、子代理(第 8 章),让代码专注于流式。

import Anthropic from "@anthropic-ai/sdk";
import { compressWorkingHistory } from "./context";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// 使用的模型。通过 .env 里的 MODEL 变量覆盖，默认走 magpie 网关的模型。
const MODEL = process.env.MODEL ?? "trae-internal/openrouter-3o";

const SYSTEM_PROMPT = `你是一个编程助手。编辑前先用 list_files 和 search_files 找到相关文件。编辑前永远先读文件。保持简洁。`;

// --- 类型 ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
}

const readTimestamps = new Map<string, number>();
const MAX_RESULT_CHARS = 10_000;

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  return result.slice(0, MAX_RESULT_CHARS) + `\n[Truncated]`;
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
    properties[key] = { type: inner instanceof z.ZodBoolean ? "boolean" : "string", description: inner._def.description || "" };
    if (!opt) required.push(key);
  }
  return { type: "object", properties, required };
}

// --- 工具 ---
const tools: Tool[] = [
  {
    name: "read_file", description: "读取文件,带行号。",
    inputSchema: z.object({ file_path: z.string() }),
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
    name: "edit_file", description: "编辑文件,用 new_string 替换 old_string。",
    inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
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
    name: "write_file", description: "创建或覆盖文件。",
    inputSchema: z.object({ file_path: z.string(), content: z.string() }),
    async call(input) {
      const fp = input.file_path as string;
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, input.content as string);
      return `Written: ${fp}`;
    },
  },
  {
    name: "list_files", description: "递归列出文件。",
    inputSchema: z.object({ directory: z.string().optional() }),
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
    name: "search_files", description: "在文件中搜索正则表达式模式。",
    inputSchema: z.object({ pattern: z.string(), directory: z.string().optional() }),
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
    name: "run_command", description: "执行一条 shell 命令。",
    inputSchema: z.object({ command: z.string() }),
    async call(input) {
      try {
        return truncateResult(execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 }) || "(no output)");
      } catch (e: any) { return `Error: ${e.stderr || e.message}`; }
    },
  },
];

const apiTools: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: zodToJsonSchema(t.inputSchema) as Anthropic.Tool["input_schema"],
}));

// --- 流式智能体循环 ---
// 与前几章的主要区别: 使用 client.messages.stream()
// 而不是 client.messages.create()。文本随着到达逐步打印。

async function agentLoop(
  messages: Anthropic.MessageParam[]
): Promise<string> {
  let turns = 0;
  const maxTurns = 20;

  while (true) {
    turns++;
    if (turns > maxTurns) return "[max turns reached]";

    // 使用流式 API 而不是 create()
    await compressWorkingHistory(messages, {
      model: { create: (request, options) => client.messages.create(request, options) },
      modelName: MODEL,
      log: console.log,
    });
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: apiTools,
      messages,
    });

    // 一边向用户流式输出文本,一边累积内容块
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
            // 立即把文本流式输出给用户
            process.stdout.write(event.delta.text);
            // 累积到历史中
            if (currentTextIndex >= 0) {
              contentBlocks[currentTextIndex].text += event.delta.text;
            }
          } else if (event.delta.type === "input_json_delta") {
            // 缓存工具输入(未完整前无法解析)
            currentToolInput += event.delta.partial_json;
          }
          break;

        case "content_block_stop":
          if (currentBlockType === "tool_use") {
            try {
              contentBlocks.push({
                type: "tool_use",
                id: currentToolId,
                name: currentToolName,
                input: currentToolInput ? JSON.parse(currentToolInput) : {},
              });
            } catch {
              contentBlocks.push({
                type: "tool_use",
                id: currentToolId,
                name: currentToolName,
                input: {},
              });
            }
            currentToolInput = "";
          }
          currentBlockType = null;
          break;
      }
    }

    // 把完整的响应加入对话历史
    messages.push({ role: "assistant", content: contentBlocks });

    // 检查是否有工具调用
    const toolBlocks = contentBlocks.filter(
      (b: any) => b.type === "tool_use"
    ) as Anthropic.ToolUseBlock[];

    if (toolBlocks.length === 0) {
      // 没有工具调用。返回累积的文本。
      process.stdout.write("\n");
      return contentBlocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
    }

    // 执行工具
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolBlocks) {
      const tool = tools.find((t) => t.name === toolUse.name);
      if (!tool) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Unknown: ${toolUse.name}`, is_error: true });
        continue;
      }

      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Invalid: ${parsed.error.message}`, is_error: true });
        continue;
      }

      console.log(`\n  [工具] ${tool.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);
      const result = await tool.call(parsed.data);
      console.log(`  [结果] ${result.slice(0, 150)}${result.length > 150 ? "..." : ""}`);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("流式智能体。文本逐 token 显示。");
  console.log('试试: "解释一下 sample-project 里的 Button 组件是做什么的"\n');

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
