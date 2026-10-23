import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

const SYSTEM_PROMPT = `你是一个编程助手。在编辑之前，用 list_files 和 search_files 找到文件。编辑文件之前一定要先读取它。保持简洁。`;

// --- 工具接口 ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
}

const readTimestamps = new Map<string, number>();

function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const normalize = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const index = normalize(fileContent).indexOf(normalize(searchString));
  if (index !== -1) return fileContent.substring(index, index + searchString.length);
  return null;
}

// --- 工具 ---
const MAX_RESULT_CHARS = 10_000; // 第 1 层：限制单个工具结果的大小

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  return result.slice(0, MAX_RESULT_CHARS) +
    `\n\n[Truncated: was ${result.length} chars, showing first ${MAX_RESULT_CHARS}]`;
}

const readFileTool: Tool = {
  name: "read_file",
  description: "读取一个文件（带行号）。编辑之前一定要先读取。",
  inputSchema: z.object({ file_path: z.string() }),
  async call(input) {
    const filePath = input.file_path as string;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      readTimestamps.set(path.resolve(filePath), Date.now());
      const numbered = content.split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n");
      return truncateResult(numbered);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
};

const editFileTool: Tool = {
  name: "edit_file",
  description: "通过把 old_string 替换成 new_string 来编辑文件。必须是唯一匹配。先读取再编辑。",
  inputSchema: z.object({
    file_path: z.string(), old_string: z.string(),
    new_string: z.string(), replace_all: z.boolean().optional(),
  }),
  async call(input) {
    const { file_path, old_string, new_string, replace_all } = input as any;
    if (old_string === new_string) return "Error: strings are identical.";
    if (!fs.existsSync(file_path)) return `Error: not found: ${file_path}`;
    const content = fs.readFileSync(file_path, "utf-8");
    const actual = findActualString(content, old_string);
    if (!actual) return "Error: old_string not found.";
    if (!replace_all && content.split(actual).length - 1 > 1)
      return "Error: multiple matches. Add more context or set replace_all.";
    const resolved = path.resolve(file_path);
    const lastRead = readTimestamps.get(resolved);
    if (lastRead) { try { if (fs.statSync(file_path).mtimeMs > lastRead) return "Error: file modified since last read."; } catch {} }
    const updated = replace_all ? content.split(actual).join(new_string) : content.replace(actual, new_string);
    fs.writeFileSync(file_path, updated);
    readTimestamps.set(resolved, Date.now());
    return `Edited ${file_path}`;
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description: "创建或覆盖一个文件。",
  inputSchema: z.object({ file_path: z.string(), content: z.string() }),
  async call(input) {
    const filePath = input.file_path as string;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, input.content as string);
    return `Written: ${filePath}`;
  },
};

const listFilesTool: Tool = {
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
};

const searchFilesTool: Tool = {
  name: "search_files",
  description: "在文件中搜索一个正则表达式。",
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
};

const runCommandTool: Tool = {
  name: "run_command",
  description: "运行一个 shell 命令。",
  inputSchema: z.object({ command: z.string() }),
  async call(input) {
    try {
      const output = execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 });
      return truncateResult(output || "(no output)");
    } catch (err: any) {
      return `Error: ${err.stderr || err.message}`;
    }
  },
};

const tools: Tool[] = [readFileTool, editFileTool, writeFileTool, listFilesTool, searchFilesTool, runCommandTool];

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

// --- token 估算 ---
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") { chars += msg.content.length; }
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") chars += block.text.length;
        else if ("content" in block && typeof block.content === "string") chars += block.content.length;
        else if ("input" in block) chars += JSON.stringify(block.input).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// --- 第 2 层：清理旧的工具结果 ---
const KEEP_RECENT_RESULTS = 6;

function clearOldResults(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const toolResultIndices: number[] = [];
  messages.forEach((msg, i) => {
    if (typeof msg.content !== "string" && Array.isArray(msg.content)) {
      if (msg.content.some((b: any) => b.type === "tool_result")) toolResultIndices.push(i);
    }
  });

  const toClear = new Set(toolResultIndices.slice(0, -KEEP_RECENT_RESULTS));

  return messages.map((msg, i) => {
    if (!toClear.has(i)) return msg;
    const content = (msg.content as any[]).map((block: any) => {
      if (block.type === "tool_result") {
        return { ...block, content: "[Cleared to save context]" };
      }
      return block;
    });
    return { ...msg, content };
  });
}

// --- 第 3 层：自动压缩（LLM 摘要）---
// 为了演示效果，这里用了一个很低的阈值，好让你能看到它触发。
// 生产环境中，这个值大约是模型上下文窗口的 80%。
const COMPACT_THRESHOLD_TOKENS = 8_000; // 演示用的低值。生产环境：约 160,000

async function autoCompact(
  messages: Anthropic.MessageParam[],
  tokenEstimate: number
): Promise<{ messages: Anthropic.MessageParam[]; wasCompacted: boolean }> {
  if (tokenEstimate < COMPACT_THRESHOLD_TOKENS) {
    return { messages, wasCompacted: false };
  }

  console.log("  [compact] 正在摘要对话以释放上下文...");

  const summaryResponse = await client.messages.create({
    model: "trae-internal/openrouter-3o",
    max_tokens: 1024,
    system:
      "请对这段用户与编程助手之间的对话进行摘要。" +
      "需要保留：文件路径、已做的代码改动、当前任务，以及用户偏好。" +
      "尽量简洁，但不要丢失重要细节。",
    messages,
  });

  const summaryText = summaryResponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // 保留最后几条消息不动
  const keepRecent = 4;
  const recentMessages = messages.slice(-keepRecent);

  const compacted: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `[对话摘要]\n${summaryText}\n\n[从这里继续。]`,
    },
    {
      role: "assistant",
      content: "明白了。我已经掌握了之前对话中的上下文。",
    },
    ...recentMessages,
  ];

  const savedTokens = tokenEstimate - estimateTokens(compacted);
  console.log(`  [compact] Saved ~${savedTokens} tokens`);

  return { messages: compacted, wasCompacted: true };
}

// --- 完整的压缩流水线 ---
async function compressMessages(
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  // 第 1 层：结果创建时就已经做过截断

  // 第 2 层：清理旧的工具结果
  let compressed = clearOldResults(messages);

  // 第 3 层：如果仍然太大，就自动压缩
  const tokenEstimate = estimateTokens(compressed);
  const { messages: compacted, wasCompacted } = await autoCompact(compressed, tokenEstimate);

  return compacted;
}

// --- 智能体循环（带压缩）---
async function agentLoop(
  conversationHistory: Anthropic.MessageParam[]
): Promise<string> {
  let turns = 0;
  const maxTurns = 20;

  const apiTools: Anthropic.Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema) as Anthropic.Tool["input_schema"],
  }));

  while (true) {
    turns++;
    if (turns > maxTurns) return "[max turns reached]";

    // 每次 API 调用前先运行压缩流水线
    const compressed = await compressMessages(conversationHistory);
    const tokenEstimate = estimateTokens(compressed);
    console.log(`  [context] ~${tokenEstimate} tokens in ${compressed.length} messages`);

    const response = await client.messages.create({
      model: "trae-internal/openrouter-3o",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: apiTools,
      messages: compressed,
    });

    conversationHistory.push({ role: "assistant", content: response.content });

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

      console.log(`  [tool] ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);
      const result = await tool.call(parsed.data);
      console.log(`  [result] ${result.slice(0, 150)}${result.length > 150 ? "..." : ""}`);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    conversationHistory.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("带上下文压缩的智能体。观察 [context] 和 [compact] 日志。");
  console.log(`压缩阈值：${COMPACT_THRESHOLD_TOKENS} tokens（演示用的低值）。`);
  console.log("读取多个文件即可触发压缩。\n");

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
