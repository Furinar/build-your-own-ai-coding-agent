import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";

const client = new Anthropic();

// 使用的模型。通过 .env 里的 MODEL 变量覆盖，默认走 magpie 网关的模型。
const MODEL = process.env.MODEL ?? "trae-internal/openrouter-3o";

// 一个简单的工具，方便我们直观地看到循环的运作。
// 模型可以调用它来“获取当前时间”。
// 下一章我们会加入真正的工具，比如文件读取和搜索。
const tools: Anthropic.Tool[] = [
  {
    name: "get_time",
    description: "获取当前的日期和时间",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// 按名称执行工具。
// 目前我们只有一个工具，后续章节会不断扩充。
function executeTool(name: string, _input: Record<string, unknown>): string {
  if (name === "get_time") {
    return new Date().toISOString();
  }
  return `Unknown tool: ${name}`;
}

// --- 智能体循环 ---
// 这是一切的核心。调用模型、检查是否有工具调用、
// 执行工具、把结果推回去，然后重复。
async function agentLoop(
  conversationHistory: Anthropic.MessageParam[]
): Promise<string> {
  let turns = 0;
  const maxTurns = 20;

  while (true) {
    turns++;
    if (turns > maxTurns) {
      return "[max turns reached]";
    }

    // 1. 带上完整的对话历史调用 API
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools,
      messages: conversationHistory,
    });

    // 2. 把助手的回复加入对话历史
    conversationHistory.push({ role: "assistant", content: response.content });

    // 3. 通过检查内容块来判断是否有工具调用。
    //    不要依赖 stop_reason，它并不总是可靠。
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      // 没有工具调用，说明模型已经完成。提取文本并返回。
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );
      return textBlocks.map((b) => b.text).join("\n");
    }

    // 4. 逐个执行工具并收集结果
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      console.log(`  [tool] ${toolUse.name}`);
      const result = executeTool(
        toolUse.name,
        toolUse.input as Record<string, unknown>
      );
      console.log(`  [result] ${result}`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // 5. 把工具结果作为一条 user 消息推回去。
    //    这是关键一步。模型会在下一轮迭代中看到它自己的工具调用
    //    以及对应的结果。
    conversationHistory.push({ role: "user", content: toolResults });

    // 6. 继续循环。模型会决定下一步做什么。
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("基础智能体循环。输入一条消息，试试 “现在几点了？”");
  console.log("按 Ctrl+C 退出。\n");

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
