import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// 使用的模型。通过 .env 里的 MODEL 变量覆盖，默认走 magpie 网关的模型。
const MODEL = process.env.MODEL ?? "trae-internal/openrouter-3o";

// --- 系统提示词 ---
// 这就是塑造模型行为的东西。没有它，模型会乱猜文件路径、
// 编辑它没读过的文件。有了它，模型会先搜索、先读取，
// 并有条不紊地工作。

const SYSTEM_PROMPT = `你是一个编程助手，帮助用户完成软件工程任务。你可以使用一些工具来读取、搜索、编辑文件以及运行命令。

# 如何工作

- 接到任务时，先从理解代码库开始。在改动之前，用 list_files 和 search_files 找到相关文件。
- 编辑文件之前一定要先读取它。绝不要凭空猜测文件里有什么。
- 用 search_files 在整个项目中查找代码模式、函数定义和使用位置。
- 当你找到多个候选文件时，读取它们，弄清楚哪一个和任务相关。

# 如何编辑文件

- 修改时使用 edit_file 工具。在 old_string 中提供足够的上下文，以保证匹配是唯一的。
- 对于新文件，使用 write_file。
- 做完编辑后，确认你的改动在上下文中是合理的。

# 如何处理歧义

- 如果用户的请求有歧义（例如有多个按钮时却说“修一下这个按钮”），就反问他们指的是哪一个。
- 如果你拿不准正确的做法，先说明你的计划，再动手改。

# 沟通

- 保持简洁。展示你改了什么，而不是你考虑过的一切。
- 汇报编辑时，说明文件路径以及改动了什么。`;

// --- 工具接口 ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
}

// --- 用于过期检测的文件读取时间戳 ---
const readTimestamps = new Map<string, number>();

function findActualString(
  fileContent: string,
  searchString: string
): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const normalize = (s: string) =>
    s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const index = normalize(fileContent).indexOf(normalize(searchString));
  if (index !== -1)
    return fileContent.substring(index, index + searchString.length);
  return null;
}

// --- 工具 ---
// 实现和第 3 章相同，只是在描述中加入了一些提示。

const readFileTool: Tool = {
  name: "read_file",
  description:
    "读取一个文件的内容（带行号）。编辑文件之前一定要先读取它。",
  inputSchema: z.object({
    file_path: z.string().describe("要读取的文件路径"),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      readTimestamps.set(path.resolve(filePath), Date.now());
      const lines = content.split("\n");
      return lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }
  },
};

const editFileTool: Tool = {
  name: "edit_file",
  description:
    "通过把 old_string 替换成 new_string 来编辑文件。" +
    "old_string 必须恰好匹配一次（除非 replace_all 为 true）。" +
    "在 old_string 中包含足够多的上下文，以保证匹配是唯一的。" +
    "编辑文件之前必须先读取它。",
  inputSchema: z.object({
    file_path: z.string().describe("要编辑的文件路径"),
    old_string: z.string().describe("要查找的确切文本"),
    new_string: z.string().describe("用来替换的文本"),
    replace_all: z.boolean().optional().describe("替换所有匹配项"),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;

    if (oldString === newString)
      return "Error: old_string and new_string are identical.";
    if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

    const content = fs.readFileSync(filePath, "utf-8");
    const actualString = findActualString(content, oldString);
    if (!actualString) return "Error: old_string not found in file.";

    if (!replaceAll) {
      const count = content.split(actualString).length - 1;
      if (count > 1)
        return `Error: Found ${count} matches. Include more context to make it unique, or set replace_all to true.`;
    }

    const resolvedPath = path.resolve(filePath);
    const lastRead = readTimestamps.get(resolvedPath);
    if (lastRead) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > lastRead)
          return "Error: File modified since last read. Read it again first.";
      } catch {}
    }

    const updated = replaceAll
      ? content.split(actualString).join(newString)
      : content.replace(actualString, newString);
    fs.writeFileSync(filePath, updated);
    readTimestamps.set(resolvedPath, Date.now());
    return `Edited ${filePath}`;
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description: "创建或覆盖一个文件，写入给定的内容。",
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
    "递归列出一个目录下的文件。在读取具体文件之前，用它来探索代码库。",
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
    "在文件中搜索一个正则表达式。返回匹配的行，并附带路径和行号。用它来查找代码模式，缩小需要读取的文件范围。",
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
  description:
    "运行一个 shell 命令。可用于运行测试、安装依赖包或查看 git 状态等任务。",
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

const tools: Tool[] = [
  readFileTool,
  editFileTool,
  writeFileTool,
  listFilesTool,
  searchFilesTool,
  runCommandTool,
];

// --- Zod 转 JSON Schema ---
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

// --- 智能体循环（现在带上了系统提示词）---
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
      system: SYSTEM_PROMPT, // <-- 系统提示词塑造行为
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

  console.log("带系统提示词的智能体。试试：");
  console.log('  “sample-project 有哪些组件？”');
  console.log('  “把 sample-project 里的标题字号改成 text-4xl”');
  console.log('  “修一下这个按钮”（它应该会反问是哪个按钮）\n');

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
