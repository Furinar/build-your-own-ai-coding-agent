import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// 使用的模型。通过 .env 里的 MODEL 变量覆盖，默认走 magpie 网关的模型。
const MODEL = process.env.MODEL ?? "trae-internal/openrouter-3o";

// --- 工具接口（和第 2 章一样）---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
}

// --- 跟踪文件读取时间戳，用于过期检测 ---
const readTimestamps = new Map<string, number>();

// --- 引号归一化 ---
// 模型有时会输出弯引号，而文件里用的是直引号。
// 这个函数会在文件中找到真正的字符串，并考虑引号差异。
function findActualString(
  fileContent: string,
  searchString: string
): string | null {
  // 先尝试精确匹配
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  // 再尝试归一化引号后匹配
  const normalize = (s: string) =>
    s
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"');

  const normalizedFile = normalize(fileContent);
  const normalizedSearch = normalize(searchString);

  const index = normalizedFile.indexOf(normalizedSearch);
  if (index !== -1) {
    return fileContent.substring(index, index + searchString.length);
  }

  return null;
}

// --- 工具实现 ---

const readFileTool: Tool = {
  name: "read_file",
  description:
    "读取一个文件的内容。返回带行号的文件内容。",
  inputSchema: z.object({
    file_path: z.string().describe("要读取的文件路径"),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      // 记录文件的读取时间（用于过期检测）
      readTimestamps.set(path.resolve(filePath), Date.now());
      const lines = content.split("\n");
      return lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }
  },
};

// --- 编辑工具 ---
// 这是本章的主角。
// 它用 string.replace() 并配合唯一性校验。
const editFileTool: Tool = {
  name: "edit_file",
  description:
    "通过把 old_string 替换成 new_string 来编辑文件。" +
    "old_string 必须在文件中恰好出现一次（除非 replace_all 为 true）。" +
    "请包含足够多的上下文，以保证匹配是唯一的。",
  inputSchema: z.object({
    file_path: z.string().describe("要编辑的文件路径"),
    old_string: z.string().describe("要查找的确切文本"),
    new_string: z
      .string()
      .describe("用来替换的文本（必须和 old_string 不同）"),
    replace_all: z
      .boolean()
      .optional()
      .describe("替换所有匹配项。默认为 false。"),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;

    // 1. 检查 old_string != new_string
    if (oldString === newString) {
      return "Error: old_string and new_string are identical. No edit needed.";
    }

    // 2. 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    // 3. 读取文件
    const content = fs.readFileSync(filePath, "utf-8");

    // 4. 找到真正的字符串（含引号归一化）
    const actualString = findActualString(content, oldString);
    if (!actualString) {
      return "Error: The old_string was not found in the file.";
    }

    // 5. 检查唯一性（除非 replace_all）
    if (!replaceAll) {
      const count = content.split(actualString).length - 1;
      if (count > 1) {
        return (
          `Error: Found ${count} matches of the old_string. ` +
          `Include more surrounding context to make the match unique, ` +
          `or set replace_all to true.`
        );
      }
    }

    // 6. 检查文件是否过期
    const resolvedPath = path.resolve(filePath);
    const lastRead = readTimestamps.get(resolvedPath);
    if (lastRead) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > lastRead) {
          return "Error: File has been modified since you last read it. Read the file again first.";
        }
      } catch {
        // 如果无法 stat，就继续执行
      }
    }

    // 7. 应用编辑
    const updated = replaceAll
      ? content.split(actualString).join(newString)
      : content.replace(actualString, newString);

    fs.writeFileSync(filePath, updated);

    // 更新读取时间戳，这样下一次编辑不会因过期检查而失败
    readTimestamps.set(resolvedPath, Date.now());

    return `Edited ${filePath}`;
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description:
    "把内容写入一个文件。需要时会创建父目录。",
  inputSchema: z.object({
    file_path: z.string().describe("要写入的文件路径"),
    content: z.string().describe("要写入的内容"),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, input.content as string);
    return `File written: ${filePath}`;
  },
};

const listFilesTool: Tool = {
  name: "list_files",
  description:
    "递归列出一个目录下的文件。会跳过 node_modules 和隐藏文件。",
  inputSchema: z.object({
    directory: z.string().optional().describe("要列出的目录。"),
  }),
  async call(input) {
    const dir = (input.directory as string) || ".";
    const files: string[] = [];
    function walk(d: string) {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(full);
        }
      } catch {}
    }
    walk(dir);
    return files.join("\n") || "(empty directory)";
  },
};

const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "在文件中搜索一个正则表达式。返回匹配的行，并附带路径和行号。",
  inputSchema: z.object({
    pattern: z.string().describe("要搜索的正则表达式"),
    directory: z.string().optional().describe("要搜索的目录。"),
  }),
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
          if (entry.isDirectory()) {
            search(full);
          } else {
            try {
              const lines = fs.readFileSync(full, "utf-8").split("\n");
              lines.forEach((line, i) => {
                if (regex.test(line))
                  results.push(`${full}:${i + 1}: ${line.trim()}`);
              });
            } catch {}
          }
        }
      } catch {}
    }
    search(dir);
    return results.slice(0, 50).join("\n") || "No matches found.";
  },
};

const runCommandTool: Tool = {
  name: "run_command",
  description: "运行一个 shell 命令并返回其输出。",
  inputSchema: z.object({
    command: z.string().describe("要运行的 shell 命令"),
  }),
  async call(input) {
    try {
      const output = execSync(input.command as string, {
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return output || "(no output)";
    } catch (err: any) {
      return `Error (exit code ${err.status ?? "unknown"}): ${err.stderr || err.message}`;
    }
  },
};

// --- 所有工具 ---
const tools: Tool[] = [
  readFileTool,
  editFileTool,
  writeFileTool,
  listFilesTool,
  searchFilesTool,
  runCommandTool,
];

// --- Zod 转 JSON Schema 转换器（简化版）---
function zodToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const zodValue = value as z.ZodTypeAny;
    const isOptional = zodValue.isOptional();
    const innerType = isOptional
      ? (zodValue as z.ZodOptional<any>)._def.innerType
      : zodValue;
    const isBoolean = innerType instanceof z.ZodBoolean;
    properties[key] = {
      type: isBoolean ? "boolean" : "string",
      description: innerType._def.description || "",
    };
    if (!isOptional) required.push(key);
  }
  return { type: "object", properties, required };
}

// --- 智能体循环 ---
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

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: apiTools,
      messages: conversationHistory,
    });

    conversationHistory.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );
      return textBlocks.map((b) => b.text).join("\n");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const tool = tools.find((t) => t.name === toolUse.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Invalid input: ${parsed.error.message}`,
          is_error: true,
        });
        continue;
      }

      const inputSummary = JSON.stringify(toolUse.input).slice(0, 100);
      console.log(`  [tool] ${toolUse.name}(${inputSummary})`);

      const result = await tool.call(parsed.data);
      const truncated =
        result.length > 200
          ? result.slice(0, 200) + `... (${result.length} chars)`
          : result;
      console.log(`  [result] ${truncated}`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    conversationHistory.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("带编辑工具的智能体。试试：");
  console.log('  “把 sample-project 里的按钮颜色改成红色”');
  console.log('  “把 sample-project 里的标题改成 Hello World”');
  console.log("");

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
