# 第 12 章：持久化

## 问题所在

关掉智能体，一切都没了——对话、读过的文件、你正在做的事。再打开它，又得从零开始。“我们刚才在干嘛来着？”“完全不知道。”

对短任务来说这没关系。但对跨越多次会话的长项目来说，这就是个问题了。你希望能合上笔记本，明天回来，从上次停下的地方接着干。

## 什么是持久化？

持久化就是把智能体的状态保存到磁盘，以便之后恢复。它有三个部分：

1. **对话历史**：保存消息，让智能体能恢复上一次的会话。
2. **项目说明**：项目里的一个文件，告诉智能体在这个特定代码库里该怎么做。它在所有会话间都持续有效。
3. **记忆**：智能体记下的关于你或项目的笔记。它在会话间持续有效。

## 演练：恢复一次会话

```
会话 1（周一）：
  > 帮我重构 auth 模块
  ...（20 轮的读取、编辑、测试）
  > 我得走了，明天继续吧
  会话已保存到 .agent/session.jsonl

会话 2（周二）：
  > /resume
  已从上次会话加载 45 条消息。
  > 从上次停下的地方继续
  智能体看到了周一的完整对话。
  它知道自己读过哪些文件、做了哪些改动。
  它从停下的地方接着来。
```

智能体没有重新读一遍每个文件，也没有重新摸索项目结构。这些都在保存下来的对话里。

## 把对话保存到磁盘

会话文件保存当前工作历史的快照，包括摘要和最近的完整轮次。使用 JSONL（JSON Lines）编码，每一行是一条消息；保存时覆盖整个快照。

```typescript
import * as fs from "fs";

const SESSION_FILE = ".agent/session.jsonl";

function saveSession(messages: Anthropic.MessageParam[]): void {
  fs.mkdirSync(".agent", { recursive: true });
  const temporary = SESSION_FILE + ".tmp";
  fs.writeFileSync(temporary, messages.map(message => JSON.stringify(message)).join("\n") + "\n");
  fs.renameSync(temporary, SESSION_FILE);
}
```

JSONL 只是编码格式，不代表追加式日志。先写临时文件，再重命名替换，避免普通写入中断留下半份快照。压缩后立即保存，下一次恢复就会得到已经压缩的工作历史。

在收到用户输入、压缩完成、纯文本回复完成，以及工具调用与结果成对完成时保存：

```typescript
// 用户发送消息之后：
conversationHistory.push({ role: "user", content: userInput });
saveSession(conversationHistory);

// 纯文本助手响应之后：
conversationHistory.push({ role: "assistant", content: response.content });
saveSession(conversationHistory);

// 如果助手发出工具调用，等所有结果一起追加后再保存：
conversationHistory.push({ role: "user", content: toolResults });
saveSession(conversationHistory);
```

保存包含工具调用的助手消息时，要同时保存它的结果，避免恢复出没有配对结果的调用。项目记忆 `memory.md` 仍是独立的长期偏好笔记，不承担原始对话日志的作用。

## 加载并恢复

要恢复，就读取 JSONL 文件，把每一行解析回一条消息：

```typescript
function loadSession(): Anthropic.MessageParam[] {
  if (!fs.existsSync(SESSION_FILE)) {
    return [];
  }

  const content = fs.readFileSync(SESSION_FILE, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  return lines.map(line => JSON.parse(line));
}
```

当用户输入 `/resume` 时，加载消息并继续。这段逻辑放在 REPL 的输入处理里，在用户输入被送进智能体循环之前：

```typescript
// 在 REPL 里读取用户输入的地方：
rl.question("> ", async (userInput) => {
  // 在送给智能体之前先处理命令
  if (userInput === "/resume") {
    const loaded = loadSession();
    if (loaded.length === 0) {
      console.log("没有找到之前的会话。");
    } else {
      replaceHistory(conversationHistory, loaded);
      console.log(`已从上次会话加载 ${loaded.length} 条消息。`);
    }
    return ask(); // 回到提示符，不送给智能体
  }

  if (userInput === "/new") {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    conversationHistory.length = 0;
    console.log("已开始新会话。");
    return ask();
  }

  // 普通输入：保存并送给智能体
  conversationHistory.push({ role: "user", content: userInput });
  saveSession(conversationHistory);
  const response = await agentLoop(conversationHistory);
  // ...
});
```

`/resume` 和 `/new` 命令在输入到达智能体之前就被拦截。它们不是工具调用，而是直接修改对话历史的 REPL 命令。

`replaceHistory` 来自 [examples/context.ts](../examples/context.ts)，它替换同一个数组里的内容。重复执行 `/resume` 不会把消息追加两遍。模型下一轮看到的是保存的工作历史快照：如果已经压缩，就继续使用摘要和最近轮次。

### 展示历史会话

我们的示例只保存一个会话文件。但如果用户有过很多次会话，想挑一个来恢复呢？

生产级智能体会给每个会话一个唯一 ID（比如 `session-<uuid>.jsonl`），并存上一些元数据，比如第一条用户消息、一个标题和时间戳。当用户要求恢复时，智能体就列出一个清单：

```
之前的会话：
  1. [4 月 3 日] “帮我重构 auth 模块”
  2. [4 月 1 日] “给设置页加上深色模式”
  3. [3 月 28 日] “修复登录 bug”

要恢复哪个会话？ >
```

它们不会为了展示这个列表而解析整个 JSONL 文件。相反，它们只读每个文件的头几行和尾几行（head 和 tail），从中提取标题和最后一条提示词。即便会话文件很大，这样也很快。

对我们的示例来说，单个会话文件就够了。但如果你想支持多个会话，模式是这样的：给每个会话一个唯一的文件名，把摘要存在第一行，列出时只读这些文件头：

```typescript
// 用唯一 ID 保存，并把摘要作为第一行
const sessionId = crypto.randomUUID();
const sessionFile = `.agent/sessions/${sessionId}.jsonl`;
fs.appendFileSync(sessionFile,
  JSON.stringify({ type: "metadata", summary: userInput, createdAt: Date.now() }) + "\n"
);

// 只读每个文件的第一行来列出会话
function listSessions(): { id: string; summary: string; date: string }[] {
  const dir = ".agent/sessions";
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => {
      const firstLine = fs.readFileSync(path.join(dir, f), "utf-8").split("\n")[0];
      const meta = JSON.parse(firstLine);
      return {
        id: f.replace(".jsonl", ""),
        summary: meta.summary,
        date: new Date(meta.createdAt).toLocaleDateString(),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}
```

每个文件的第一行是一条带摘要的元数据记录。列出会话时，每个文件只读这一行，而不是整段对话。

## 项目说明

有些说明对项目里的每次会话都适用。“这个项目用 Tailwind。”“用 npm test 跑测试。”“API 在 src/api/ 里。”你不会想每次启动智能体时都把这些重说一遍。

解决办法是：在项目根目录放一个 Markdown 文件，智能体自动读取。我们叫它 `AGENT.md`，但你爱叫什么都行。Claude Code 用的是 `CLAUDE.md`，Codex 用的是 `AGENTS.md`。名字不重要，思路是一样的。

```typescript
const PROJECT_INSTRUCTIONS_FILE = "AGENT.md";

function loadProjectInstructions(): string | null {
  if (!fs.existsSync(PROJECT_INSTRUCTIONS_FILE)) {
    return null;
  }
  return fs.readFileSync(PROJECT_INSTRUCTIONS_FILE, "utf-8");
}
```

如果这个文件存在，它的内容就会被加进系统提示词。本章后面我们会把它连同记忆一起接入 `buildSystemPrompt()`。

现在团队里任何开发者都可以往仓库里加一个 `AGENT.md`：

```markdown
# 项目说明

- 这是一个用 Tailwind CSS 的 React + TypeScript 项目。
- 用 `npm test` 跑测试。
- API 层在 `src/api/`。不要改 `src/generated/` 里的文件。
- 用函数组件，不要用类组件。
- 函数参数总是要加类型。
```

智能体每次启动都读这个文件并遵照执行。这就像给 AI 的一份入职文档。

### 优先级层次

生产级智能体支持多个不同层级的说明文件：

```
~/.agent/AGENT.md             → 全局（所有项目）
./AGENT.md                    → 项目（和团队共享）
./AGENT.local.md              → 本地（你个人的覆盖项，被 gitignore）
```

每一层都在前一层基础上叠加。全局说明到处适用，项目说明适用于这个仓库，本地说明是你不想提交的个人偏好。

我们的示例保持简单，只用一个文件。但这个模式可以很自然地扩展。

## 跨会话的记忆

项目说明是静态的。你写一次，它们就一直在。但智能体在对话中学到的东西呢？“用户喜欢用 tab 而不是空格。”“部署密钥在 1Password 里。”“我们决定用 Zustand 而不是 Redux。”

记忆是一个智能体可以读写的文件，它在会话间持续有效：

```typescript
const MEMORY_FILE = ".agent/memory.md";

const memoryTool: Tool = {
  name: "save_memory",
  description:
    "Save a note to memory that persists across sessions. " +
    "Use this for user preferences, project decisions, or important context.",
  inputSchema: z.object({
    content: z.string().describe("The note to save"),
  }),
  async call(input) {
    fs.mkdirSync(".agent", { recursive: true });
    const content = input.content as string;
    const timestamp = new Date().toISOString().split("T")[0];
    fs.appendFileSync(MEMORY_FILE, `\n- [${timestamp}] ${content}`);
    return "已保存到记忆。";
  },
};
```

启动时，加载记忆文件并加进系统提示词。在第 4 章，我们的系统提示词是个简单常量。现在它需要包含动态内容（项目说明和记忆），所以我们把它变成一个函数，从所有来源拼出完整的提示词：

```typescript
function loadMemory(): string | null {
  if (!fs.existsSync(MEMORY_FILE)) return null;
  return fs.readFileSync(MEMORY_FILE, "utf-8");
}

function buildSystemPrompt(): string {
  const base = `你是一个编程助手。你可以读取、搜索、编辑本地文件。
用 save_memory 记下关于用户或项目的重要信息。`;

  const parts = [base];

  const instructions = loadProjectInstructions();
  if (instructions) {
    parts.push(`# 项目说明（来自 AGENT.md）\n${instructions}`);
  }

  const memory = loadMemory();
  if (memory) {
    parts.push(`# 记忆（来自以往会话）\n${memory}`);
  }

  return parts.join("\n\n");
}
```

在智能体循环里调用 `buildSystemPrompt()`，而不是启动时只调用一次。这样，如果智能体在第 3 轮保存了一条记忆，第 4 轮的系统提示词就会包含它：

```typescript
while (true) {
  const systemPrompt = buildSystemPrompt(); // 每轮都重新构建

  const stream = client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    tools: apiTools,
    messages,
  });

  // ... 循环的其余部分
}
```

智能体每次会话都能看到自己过去的笔记。随着时间推移，记忆文件逐渐拼出一幅关于用户和项目的全景：

```markdown
- [2026-03-15] 用户偏好 Tailwind，不喜欢内联样式
- [2026-03-15] 数据库迁移工具在 scripts/migrate.ts
- [2026-03-18] 用户决定用 Zustand 做状态管理
- [2026-04-01] 部署流程：先 npm run build，再 scripts/deploy.sh
```

生产级智能体更进一步，用 AI 来挑选记忆。它们不会加载整个记忆文件，而是用一个便宜的模型挑出和当前任务最相关的 5 到 10 条记忆。不过对于较小的记忆文件，简单的“全部加载”就够用了。

## 还缺什么

没有了。你现在已经构建出一个完整的 AI 编程智能体，在一个简单的 while 循环之上叠了 12 项特性。下一章也是最后一章，会做个收尾，给出一些可以继续往下走的方向。

## 运行示例

```bash
npm run example:12
```

试试：
1. 进行一段对话（“读一下 sample-project 里的 Button 组件”）
2. 关掉智能体（Ctrl+C）
3. 再次运行，输入 `/resume`
4. 智能体加载出之前的对话

也可以试试：
- 在项目根目录创建一个 `AGENT.md` 文件，写上一些说明
- 让智能体“记住我偏好深色主题”（它会存进记忆）
- 重启，确认记忆还在
