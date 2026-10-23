import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// --- 工具接口 ---
// 每个工具都有名称、描述、用于校验输入的 Zod schema，
// 以及一个实际执行工作的 call() 函数。

interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
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
    try {
      const content = fs.readFileSync(input.file_path as string, "utf-8");
      const lines = content.split("\n");
      return lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description:
    "把内容写入一个文件。需要时会创建父目录。会覆盖已存在的文件。",
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
    directory: z
      .string()
      .optional()
      .describe("要列出的目录。默认为当前目录。"),
  }),
  async call(input) {
    const dir = (input.directory as string) || ".";
    const files: string[] = [];

    function walk(d: string) {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(full);
        }
      } catch {
        // 跳过无法读取的目录
      }
    }

    walk(dir);
    return files.join("\n") || "(empty directory)";
  },
};

const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "在文件中搜索一个正则表达式。返回匹配的行，并附带文件路径和行号。",
  inputSchema: z.object({
    pattern: z.string().describe("要搜索的正则表达式"),
    directory: z
      .string()
      .optional()
      .describe("要搜索的目录。默认为当前目录。"),
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
          if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            search(full);
          } else {
            try {
              const lines = fs.readFileSync(full, "utf-8").split("\n");
              lines.forEach((line, i) => {
                if (regex.test(line)) {
                  results.push(`${full}:${i + 1}: ${line.trim()}`);
                }
              });
            } catch {
              // 跳过二进制文件
            }
          }
        }
      } catch {
        // 跳过无法读取的目录
      }
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
  writeFileTool,
  listFilesTool,
  searchFilesTool,
  runCommandTool,
];

// 把 Zod schema 转换成 API 需要的 JSON Schema 格式。
// 这是一个简化版转换。生产环境中请用 zod-to-json-schema 之类的库。
function zodToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodValue = value as z.ZodTypeAny;
    const isOptional = zodValue.isOptional();

    // 如果是可选字段，提取其内部类型
    const innerType = isOptional
      ? (zodValue as z.ZodOptional<z.ZodString>)._def.innerType
      : zodValue;

    properties[key] = {
      type: "string",
      description: innerType._def.description || "",
    };

    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required,
  };
}

// --- 智能体循环（和第 1 章一样，但现在用上了真正的工具）---

async function agentLoop(
  conversationHistory: Anthropic.MessageParam[]
): Promise<string> {
  let turns = 0;
  const maxTurns = 20;

  // 根据我们的工具构建 API 的工具定义
  const apiTools: Anthropic.Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema) as Anthropic.Tool["input_schema"],
  }));

  while (true) {
    turns++;
    if (turns > maxTurns) {
      return "[max turns reached]";
    }

    const response = await client.messages.create({
      model: "trae-internal/openrouter-3o",
      max_tokens: 4096,
      tools: apiTools,
      messages: conversationHistory,
    });

    conversationHistory.push({ role: "assistant", content: response.content });

    // 检查内容中的 tool_use 块（而不是 stop_reason）
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );
      return textBlocks.map((b) => b.text).join("\n");
    }

    // 逐个执行工具
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const tool = tools.find((t) => t.name === toolUse.name);

      if (!tool) {
        console.log(`  [tool] ${toolUse.name} (unknown)`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      // 用 Zod 校验输入
      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        console.log(`  [tool] ${toolUse.name} (invalid input)`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Invalid input: ${parsed.error.message}`,
          is_error: true,
        });
        continue;
      }

      // 记录工具正在做什么
      const inputSummary = JSON.stringify(toolUse.input).slice(0, 80);
      console.log(`  [tool] ${toolUse.name}(${inputSummary})`);

      // 执行
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

    // 把结果推回对话中
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

  console.log("带工具的智能体。试试：");
  console.log('  “sample-project 里有哪些文件？”');
  console.log('  “读取 sample-project 中的 Button 组件”');
  console.log('  “在 sample-project 中搜索 className”\n');

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
