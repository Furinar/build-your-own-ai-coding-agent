// 本示例聚焦于: 子代理(第 8 章)。
// 包含: 工具(第 2 章)、编辑(第 3 章)、系统提示词(第 4 章)、上下文(第 5 章)、压缩(第 6 章)。
// 省略: 权限(第 7 章),让代码专注于子代理这个概念。

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// 使用的模型。通过 .env 里的 MODEL 变量覆盖，默认走 magpie 网关的模型。
const MODEL = process.env.MODEL ?? "trae-internal/openrouter-3o";

const SYSTEM_PROMPT = `你是一个编程助手。编辑前先用 list_files 和 search_files 找到相关文件。编辑前永远先读文件。保持简洁。

你有一个 "subagent" 工具。用它把会产生大量输出的探索或调研任务委派出去。子代理在自己的上下文里工作,它的工具结果不会弄乱你的上下文。`;

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
  return result.slice(0, MAX_RESULT_CHARS) + `\n[Truncated: ${result.length} chars]`;
}

function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const normalize = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const index = normalize(fileContent).indexOf(normalize(searchString));
  if (index !== -1) return fileContent.substring(index, index + searchString.length);
  return null;
}

function zodToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const zodValue = value as z.ZodTypeAny;
    const isOptional = zodValue.isOptional();
    const innerType = isOptional ? (zodValue as z.ZodOptional<any>)._def.innerType : zodValue;
    const isBoolean = innerType instanceof z.ZodBoolean;
    properties[key] = { type: isBoolean ? "boolean" : "string", description: innerType._def.description || "" };
    if (!isOptional) required.push(key);
  }
  return { type: "object", properties, required };
}

// --- 工具(不含子代理,子代理单独添加) ---

const baseTools: Tool[] = [
  {
    name: "read_file",
    description: "读取文件,带行号。",
    inputSchema: z.object({ file_path: z.string() }),
    async call(input) {
      const filePath = input.file_path as string;
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        readTimestamps.set(path.resolve(filePath), Date.now());
        return truncateResult(content.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"));
      } catch (err: any) { return `Error: ${err.message}`; }
    },
  },
  {
    name: "edit_file",
    description: "编辑文件,用 new_string 替换 old_string。请先读取文件。",
    inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
    async call(input) {
      const { file_path, old_string, new_string, replace_all } = input as any;
      if (old_string === new_string) return "Error: strings identical.";
      if (!fs.existsSync(file_path)) return `Error: not found: ${file_path}`;
      const content = fs.readFileSync(file_path, "utf-8");
      const actual = findActualString(content, old_string);
      if (!actual) return "Error: old_string not found.";
      if (!replace_all && content.split(actual).length - 1 > 1) return "Error: multiple matches.";
      const updated = replace_all ? content.split(actual).join(new_string) : content.replace(actual, new_string);
      fs.writeFileSync(file_path, updated);
      readTimestamps.set(path.resolve(file_path), Date.now());
      return `Edited ${file_path}`;
    },
  },
  {
    name: "write_file",
    description: "创建或覆盖文件。",
    inputSchema: z.object({ file_path: z.string(), content: z.string() }),
    async call(input) {
      const filePath = input.file_path as string;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, input.content as string);
      return `Written: ${filePath}`;
    },
  },
  {
    name: "list_files",
    description: "递归列出文件。",
    inputSchema: z.object({ directory: z.string().optional() }),
    async call(input) {
      const dir = (input.directory as string) || ".";
      const files: string[] = [];
      function walk(d: string) {
        try {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full); else files.push(full);
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
    async call(input) {
      const dir = (input.directory as string) || ".";
      let regex: RegExp;
      try { regex = new RegExp(input.pattern as string); }
      catch { return "Error: Invalid regex pattern."; }
      const results: string[] = [];
      function search(d: string) {
        try {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) { search(full); } else {
              try { fs.readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
                if (regex.test(line)) results.push(`${full}:${i + 1}: ${line.trim()}`);
              }); } catch {}
            }
          }
        } catch {}
      }
      search(dir);
      return truncateResult(results.slice(0, 50).join("\n") || "No matches.");
    },
  },
  {
    name: "run_command",
    description: "执行一条 shell 命令。",
    inputSchema: z.object({ command: z.string() }),
    async call(input) {
      try {
        return truncateResult(execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 }) || "(no output)");
      } catch (err: any) { return `Error: ${err.stderr || err.message}`; }
    },
  },
];

// --- 智能体循环 ---
async function agentLoop(
  messages: Anthropic.MessageParam[],
  options: { maxTurns?: number; depth?: number } = {}
): Promise<string> {
  const maxTurns = options.maxTurns ?? 20;
  const depth = options.depth ?? 0;
  const indent = "  ".repeat(depth);
  let turns = 0;

  // 子代理工具: 用隔离的消息递归调用 agentLoop。
  // 只在顶层可用(子代理不能再派生子子代理)。
  const subagentTool: Tool = {
    name: "subagent",
    description:
      "把任务委派给一个拥有独立上下文的子代理。" +
      "用于会产生大量输出的探索或调研。" +
      "子代理返回一段文本摘要。",
    inputSchema: z.object({
      prompt: z.string().describe("交给子代理的任务"),
    }),
    async call(input) {
      console.log(`${indent}  [子代理] 启动中...`);
      const subMessages: Anthropic.MessageParam[] = [
        { role: "user", content: input.prompt as string },
      ];
      const result = await agentLoop(subMessages, {
        maxTurns: 10,
        depth: depth + 1,
      });
      console.log(`${indent}  [子代理] 完成 (${result.length} 字符)`);
      return result;
    },
  };

  // 顶层智能体拥有子代理工具。子代理没有(避免递归)。
  const allTools = depth === 0 ? [...baseTools, subagentTool] : baseTools;

  const apiTools: Anthropic.Tool[] = allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema) as Anthropic.Tool["input_schema"],
  }));

  while (true) {
    turns++;
    if (turns > maxTurns) return "[max turns reached]";

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: apiTools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("\n");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const tool = allTools.find((t) => t.name === toolUse.name);
      if (!tool) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Unknown: ${toolUse.name}`, is_error: true });
        continue;
      }

      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Invalid: ${parsed.error.message}`, is_error: true });
        continue;
      }

      console.log(`${indent}  [工具] ${tool.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);
      const result = await tool.call(parsed.data);
      console.log(`${indent}  [结果] ${result.slice(0, 150)}${result.length > 150 ? "..." : ""}`);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("带子代理的智能体。模型可以把任务委派给隔离的子循环。");
  console.log('试试: "用一个子代理探索 sample-project 里的所有文件并逐个描述"\n');

  const ask = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();
      conversationHistory.push({ role: "user", content: trimmed });
      console.log("");
      const response = await agentLoop(conversationHistory);
      console.log(`\n${response}\n`);
      ask();
    });
  };
  ask();
}

main();
