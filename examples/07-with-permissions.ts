import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// 使用的模型。通过 .env 里的 MODEL 变量覆盖，默认走 magpie 网关的模型。
const MODEL = process.env.MODEL ?? "trae-internal/openrouter-3o";

const SYSTEM_PROMPT = `你是一个编程助手。编辑前先用 list_files 和 search_files 找到相关文件。编辑前永远先读文件。保持简洁。`;

// --- 权限类型 ---
type PermissionDecision = "allow" | "ask" | "deny";
type PermissionMode = "default" | "plan" | "yolo";

let permissionMode: PermissionMode = "default";

interface PermissionRule {
  toolName: string;
  pattern?: string;
  decision: "allow" | "deny";
}

const rules: PermissionRule[] = [
  // 安全的只读命令始终允许
  { toolName: "run_command", pattern: "^(ls|cat|echo|pwd|git status|git diff|git log)", decision: "allow" },
  // 危险的命令模式始终拒绝
  { toolName: "run_command", pattern: "rm\\s+-rf\\s+/", decision: "deny" },
];

function checkRules(toolName: string, input: Record<string, unknown>): PermissionDecision | null {
  const inputStr = JSON.stringify(input);
  for (const rule of rules) {
    if (rule.toolName !== toolName) continue;
    if (rule.pattern && !new RegExp(rule.pattern).test(inputStr)) continue;
    return rule.decision;
  }
  return null;
}

function getEffectiveDecision(toolDecision: PermissionDecision, mode: PermissionMode): PermissionDecision {
  if (mode === "yolo") return "allow";
  if (mode === "plan" && toolDecision !== "allow") return "deny";
  return toolDecision;
}

// --- 工具接口(现在带有权限) ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
  checkPermissions(input: Record<string, unknown>): PermissionDecision;
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

// --- 带权限检查的工具 ---

const readFileTool: Tool = {
  name: "read_file",
  description: "读取文件,带行号。",
  inputSchema: z.object({ file_path: z.string() }),
  checkPermissions() { return "allow"; }, // 读取始终安全
  async call(input) {
    const filePath = input.file_path as string;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      readTimestamps.set(path.resolve(filePath), Date.now());
      return truncateResult(content.split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n"));
    } catch (err: any) { return `Error: ${err.message}`; }
  },
};

const editFileTool: Tool = {
  name: "edit_file",
  description: "编辑文件,用 new_string 替换 old_string。请先读取文件。",
  inputSchema: z.object({
    file_path: z.string(), old_string: z.string(),
    new_string: z.string(), replace_all: z.boolean().optional(),
  }),
  checkPermissions() { return "ask"; }, // 编辑需要审批
  async call(input) {
    const { file_path, old_string, new_string, replace_all } = input as any;
    if (old_string === new_string) return "Error: strings identical.";
    if (!fs.existsSync(file_path)) return `Error: not found: ${file_path}`;
    const content = fs.readFileSync(file_path, "utf-8");
    const actual = findActualString(content, old_string);
    if (!actual) return "Error: old_string not found.";
    if (!replace_all && content.split(actual).length - 1 > 1)
      return "Error: multiple matches.";
    const resolved = path.resolve(file_path);
    const lastRead = readTimestamps.get(resolved);
    if (lastRead) { try { if (fs.statSync(file_path).mtimeMs > lastRead) return "Error: file changed since read."; } catch {} }
    const updated = replace_all ? content.split(actual).join(new_string) : content.replace(actual, () => new_string);
    fs.writeFileSync(file_path, updated);
    readTimestamps.set(resolved, Date.now());
    return `Edited ${file_path}`;
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description: "创建或覆盖文件。",
  inputSchema: z.object({ file_path: z.string(), content: z.string() }),
  checkPermissions() { return "ask"; }, // 写入需要审批
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
  checkPermissions() { return "allow"; },
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
  description: "在文件中搜索正则表达式模式。",
  inputSchema: z.object({ pattern: z.string(), directory: z.string().optional() }),
  checkPermissions() { return "allow"; },
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
  description: "执行一条 shell 命令。",
  inputSchema: z.object({ command: z.string() }),
  checkPermissions(input) {
    const cmd = input.command as string;
    if (/^(ls|cat|echo|pwd|git\s+(status|diff|log))/.test(cmd)) return "allow";
    return "ask";
  },
  async call(input) {
    try {
      return truncateResult(execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 }) || "(no output)");
    } catch (err: any) { return `Error: ${err.stderr || err.message}`; }
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

// --- 权限对话 ---
async function askUserPermission(
  toolName: string,
  input: Record<string, unknown>,
  rl: readline.Interface
): Promise<boolean> {
  const inputStr = JSON.stringify(input, null, 2).slice(0, 200);
  console.log(`\n  需要权限: ${toolName}`);
  console.log(`  输入: ${inputStr}`);

  return new Promise((resolve) => {
    rl.question("  允许? [y]是 / [n]否 / [a]始终 > ", (answer) => {
      const choice = answer.trim().toLowerCase();
      if (choice === "a" || choice === "always") {
        rules.push({ toolName, decision: "allow" });
        console.log(`  已添加规则: 始终允许 ${toolName}\n`);
        resolve(true);
      } else {
        resolve(choice === "y" || choice === "yes");
      }
    });
  });
}

// --- 智能体循环(带权限) ---
async function agentLoop(
  conversationHistory: Anthropic.MessageParam[],
  rl: readline.Interface
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

    const tokenEstimate = estimateTokens(conversationHistory);
    console.log(`  [上下文] ~${tokenEstimate} tokens`);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: apiTools,
      messages: conversationHistory,
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

      // --- 权限检查 ---
      const ruleDecision = checkRules(tool.name, toolUse.input as Record<string, unknown>);
      const toolDecision = ruleDecision ?? tool.checkPermissions(toolUse.input as Record<string, unknown>);
      const finalDecision = getEffectiveDecision(toolDecision, permissionMode);

      if (finalDecision === "deny") {
        console.log(`  [已拒绝] ${tool.name}`);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Permission denied.", is_error: true });
        continue;
      }

      if (finalDecision === "ask") {
        const allowed = await askUserPermission(tool.name, toolUse.input as Record<string, unknown>, rl);
        if (!allowed) {
          console.log(`  [被用户拒绝] ${tool.name}`);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Permission denied by user.", is_error: true });
          continue;
        }
      }

      // 执行工具
      console.log(`  [工具] ${tool.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);
      const result = await tool.call(parsed.data);
      console.log(`  [结果] ${result.slice(0, 150)}${result.length > 150 ? "..." : ""}`);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    conversationHistory.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`带权限的智能体(模式: ${permissionMode})。`);
  console.log("读取操作自动允许。编辑和命令会请求权限。");
  console.log('试试: "把 sample-project 里按钮的颜色改成红色"\n');

  const ask = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();
      if (trimmed === "/yolo") { permissionMode = "yolo"; console.log("模式: yolo (全部允许)\n"); return ask(); }
      if (trimmed === "/plan") { permissionMode = "plan"; console.log("模式: plan (只读)\n"); return ask(); }
      if (trimmed === "/default") { permissionMode = "default"; console.log("模式: default\n"); return ask(); }

      conversationHistory.push({ role: "user", content: trimmed });
      console.log("");
      const response = await agentLoop(conversationHistory, rl);
      console.log(`\n${response}\n`);
      ask();
    });
  };
  ask();
}

main();
