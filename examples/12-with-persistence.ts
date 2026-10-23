// 本示例聚焦于: 持久化(第 12 章)。
// 包含: 工具(第 2 章)、编辑(第 3 章)、系统提示词(第 4 章)、流式(第 9 章)。
// 省略: 权限(第 7 章)、子代理(第 8 章)、压缩(第 6 章)、并发(第 10 章)、
//        网络访问(第 11 章),让代码专注于持久化。

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// 使用的模型。通过 .env 里的 MODEL 变量覆盖，默认走 magpie 网关的模型。
const MODEL = process.env.MODEL ?? "trae-internal/openrouter-3o";

// --- 持久化路径 ---
const AGENT_DIR = ".agent";
const SESSION_FILE = path.join(AGENT_DIR, "session.jsonl");
const MEMORY_FILE = path.join(AGENT_DIR, "memory.md");
const PROJECT_INSTRUCTIONS_FILE = "AGENT.md";

// --- 加载项目说明和记忆 ---
function loadProjectInstructions(): string | null {
  try {
    if (fs.existsSync(PROJECT_INSTRUCTIONS_FILE)) {
      return fs.readFileSync(PROJECT_INSTRUCTIONS_FILE, "utf-8");
    }
  } catch {}
  return null;
}

function loadMemory(): string | null {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return fs.readFileSync(MEMORY_FILE, "utf-8");
    }
  } catch {}
  return null;
}

// 构建系统提示词,可选地附带项目说明和记忆
function buildSystemPrompt(): string {
  const base = `你是一个编程助手。你可以读取、搜索和编辑本地文件,抓取网页,并把笔记保存到记忆中。

# 如何工作
- 编辑前先用 list_files 和 search_files 找到相关文件。
- 编辑前永远先读文件。
- 用 save_memory 记住关于用户或项目的重要信息。
- 保持简洁。`;

  const parts = [base];

  const instructions = loadProjectInstructions();
  if (instructions) {
    parts.push(`# 项目说明(来自 AGENT.md)\n${instructions}`);
  }

  const memory = loadMemory();
  if (memory) {
    parts.push(`# 记忆(来自以往会话)\n${memory}`);
  }

  return parts.join("\n\n");
}

// --- 会话保存/加载 ---
function saveMessage(message: Anthropic.MessageParam): void {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.appendFileSync(SESSION_FILE, JSON.stringify(message) + "\n");
}

function loadSession(): Anthropic.MessageParam[] {
  if (!fs.existsSync(SESSION_FILE)) return [];
  try {
    const content = fs.readFileSync(SESSION_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function clearSession(): void {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
}

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
      const u = ra ? c.split(a).join(ns) : c.replace(a, ns);
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

  // --- 记忆工具(本章新增) ---
  {
    name: "save_memory",
    description:
      "把一条笔记保存到跨会话持久化的记忆中。" +
      "用于用户偏好、项目决策或重要上下文。",
    inputSchema: z.object({
      content: z.string().describe("要保存的笔记"),
    }),
    isConcurrencySafe: false,
    async call(input) {
      fs.mkdirSync(AGENT_DIR, { recursive: true });
      const content = input.content as string;
      const date = new Date().toISOString().split("T")[0];
      fs.appendFileSync(MEMORY_FILE, `\n- [${date}] ${content}`);
      return "Saved to memory.";
    },
  },
];

const apiTools: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: zodToJsonSchema(t.inputSchema) as Anthropic.Tool["input_schema"],
}));

// --- 流式智能体循环 ---

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  let turns = 0;
  const maxTurns = 20;
  const systemPrompt = buildSystemPrompt();

  while (true) {
    turns++;
    if (turns > maxTurns) return "[max turns reached]";

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
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

    // 保存 assistant 消息
    const assistantMsg: Anthropic.MessageParam = { role: "assistant", content: contentBlocks };
    messages.push(assistantMsg);
    saveMessage(assistantMsg);

    const toolBlocks = contentBlocks.filter((b: any) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    if (toolBlocks.length === 0) {
      process.stdout.write("\n");
      return contentBlocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    }

    // 执行工具
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolBlocks) {
      const tool = tools.find(t => t.name === toolUse.name);
      if (!tool) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Unknown: ${toolUse.name}`, is_error: true });
        continue;
      }
      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Invalid: ${parsed.error.message}`, is_error: true });
        continue;
      }
      console.log(`  [工具] ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 80)})`);
      try {
        const result = await tool.call(parsed.data);
        console.log(`  [结果] ${result.slice(0, 150)}${result.length > 150 ? "..." : ""}`);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
      } catch (e: any) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Error: ${e.message}`, is_error: true });
      }
    }

    // 保存工具结果
    const toolResultMsg: Anthropic.MessageParam = { role: "user", content: toolResults };
    messages.push(toolResultMsg);
    saveMessage(toolResultMsg);
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // 检查项目说明
  const instructions = loadProjectInstructions();
  if (instructions) {
    console.log("已从 AGENT.md 加载项目说明");
  }

  // 检查记忆
  const memory = loadMemory();
  if (memory) {
    console.log("已从之前的会话加载记忆");
  }

  // 检查已有会话
  const existingSession = loadSession();
  if (existingSession.length > 0) {
    console.log(`发现之前的会话(${existingSession.length} 条消息)。输入 /resume 加载它。`);
  }

  console.log("\n带持久化的智能体。命令:");
  console.log("  /resume  - 加载之前的会话");
  console.log("  /new     - 开始新会话(删除已保存的会话)");
  console.log("  /memory  - 显示已保存的记忆");
  console.log('  试试: "记住我偏好深色主题"\n');

  const ask = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();

      // 处理命令
      if (trimmed === "/resume") {
        const loaded = loadSession();
        if (loaded.length === 0) {
          console.log("未找到之前的会话。\n");
        } else {
          conversationHistory.push(...loaded);
          console.log(`已从之前的会话加载 ${loaded.length} 条消息。\n`);
        }
        return ask();
      }

      if (trimmed === "/new") {
        clearSession();
        conversationHistory.length = 0;
        console.log("已开始新会话。\n");
        return ask();
      }

      if (trimmed === "/memory") {
        const mem = loadMemory();
        if (mem) {
          console.log(`记忆:\n${mem}\n`);
        } else {
          console.log("还没有保存任何记忆。\n");
        }
        return ask();
      }

      // 保存用户消息
      const userMsg: Anthropic.MessageParam = { role: "user", content: trimmed };
      conversationHistory.push(userMsg);
      saveMessage(userMsg);

      console.log("");
      await agentLoop(conversationHistory);
      console.log("");
      ask();
    });
  };
  ask();
}

main();
