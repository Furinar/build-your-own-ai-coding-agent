# 第 13 章：接下来呢

## 你构建了什么

在过去 12 章里，你从零构建了一个完整的 AI 编程智能体：

| 章节 | 你加上了什么 |
|---|---|
| 1. 智能体循环 | `while(true)` 内核。模型调用工具、拿到结果、决定下一步做什么。 |
| 2. 工具 | 读、写、搜索、列目录、跑命令。模型的眼睛和双手。 |
| 3. 编辑工具 | 带唯一性校验的 `string.replace()`。AI 真正是怎么改文件的。 |
| 4. 系统提示词 | “假设之前先搜索，编辑之前先阅读。”塑造行为的那些指令。 |
| 5. 上下文 | 每轮都发送完整的对话历史。追问之所以有效，是因为上下文一路带下来。 |
| 6. 压缩 | 截断、清理旧结果、LLM 总结。上下文快用完时让对话活下去。 |
| 7. 权限 | 允许、询问、拒绝。模型意图和实际执行之间的一道门。 |
| 8. 子代理 | 同一个循环，隔离的上下文。委派任务却不污染上下文。 |
| 9. 流式输出 | 逐 token 输出。哪怕模型其实没那么快，感觉上也很快。 |
| 10. 并发 | 安全的工具并行跑，不安全的工具单独跑。 |
| 11. 访问网络 | 抓取 URL、搜索网络。智能体能读文档、查资料。 |
| 12. 持久化 | 把对话存到磁盘、之后恢复、跨会话延续的项目说明。 |

这些就是生产级 AI 编程工具背后的核心理念。实现是简化过的，但架构是真实的。

## 生产级智能体还会加什么

如果你想再往前走，下面这些是生产级工具重点投入的方向：

### MCP（Model Context Protocol，模型上下文协议）

MCP 是一个把 AI 模型连接到外部工具和数据源的标准。不像我们那样把工具写死，MCP 让用户能插入来自任何提供方的工具：数据库工具、Jira 集成、自定义 API 客户端。模型在运行时发现可用的工具。

```typescript
// 不再是写死的工具：
const tools = [readFileTool, editFileTool, ...];

// MCP 让用户动态配置工具：
const tools = [
  ...builtInTools,
  ...await loadMCPTools("./mcp-config.json"),  // 用户提供的工具
];
```

模型并不在乎工具是从哪来的。它看到的是同一套接口（名称、描述、输入 schema、调用）。MCP 只是把工具的发现和加载方式标准化了。规范见 [modelcontextprotocol.io](https://modelcontextprotocol.io)。

### LSP（Language Server Protocol，语言服务器协议）集成

语言服务器提供诊断信息（类型错误、lint 警告）、代码导航（跳转定义、查找引用）和自动补全。把智能体连上 LSP，意味着它能看到和你编辑器里一样的错误。

```typescript
// 编辑文件之后，检查有没有错误：
const diagnostics = await lspClient.getDiagnostics("src/App.tsx");
// 返回：[{ line: 15, message: "Type 'string' is not assignable to type 'number'" }]

// 智能体看到错误，可以在下一轮修掉它
```

没有 LSP，智能体要等到有人跑编译器才知道类型错误。有了 LSP，它每次编辑之后都能立即得到反馈。

### Git 集成

生产级智能体用 git 跟踪改动。它们可以展示自己改了什么的 diff、创建提交、开 pull request，出问题还能回滚。

```typescript
// 做完编辑后，智能体可以：
await exec("git diff");           // 展示改了什么
await exec("git add -A");         // 暂存改动
await exec("git commit -m '...'"); // 带消息提交
await exec("git stash");          // 出问题就撤销
```

Git 让用户有信心随时能撤销智能体的工作。有些智能体甚至在每次编辑前都先创建一个提交，这样每一处改动都可逆。

### 多模型策略

不是每个任务都需要最强的模型。你可以针对不同的活儿用不同的模型：

```typescript
// 主循环：用强力模型做决策
const mainModel = "claude-sonnet-4-20250514";

// 总结（第 6 章）：便宜模型
const summaryModel = "claude-haiku-4-5-20251001";

// 网络抓取的内容提取（第 11 章）：便宜模型
const extractionModel = "claude-haiku-4-5-20251001";

// 探索用的子代理（第 8 章）：可以用更小的模型
const exploreModel = "claude-haiku-4-5-20251001";
```

这能降低成本和延迟。主循环用最好的模型来选工具和改代码，其他一切都用便宜的。

### 提示词缓存

当你每次 API 调用都发送同样的系统提示词和对话前缀时，这些 token 你每次都得付钱。提示词缓存把处理好的前缀存在服务端，跨调用复用。

```typescript
const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  system: [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },  // 缓存这个块
    },
  ],
  // ...
});
```

第一次调用处理完整的系统提示词。后续调用复用缓存的版本。这既省成本（缓存的 token 更便宜），又省延迟（不用重新处理）。

### 文件监听

当用户在智能体之外（在自己的编辑器里）改了文件，智能体应该察觉到。文件监听器检测改动，可以实时更新陈旧缓存。

```typescript
import { watch } from "fs";

// 监听项目目录的改动
watch("src/", { recursive: true }, (event, filename) => {
  // 更新读取时间戳，让智能体知道文件变了
  readTimestamps.delete(path.resolve("src/", filename));
});
```

没有文件监听，智能体只能靠编辑时的陈旧检查（第 3 章）。有了文件监听，文件一变它立刻就知道。

## 构建一个 TUI

我们的示例用的是一个简单的 readline 提示符。像 Claude Code 这样的生产级智能体有一个完整的终端界面（TUI），带颜色、加载动画、语法高亮，还有交互式的权限对话框。

如果你想做一个像样的 TUI，这里有几个库可以看看：

- **[Ink](https://github.com/vadimdemedes/ink)** —— 终端里的 React。用 React 组件构建终端界面。Claude Code 用的就是它。
- **[Blessed](https://github.com/chjj/blessed)** —— Node.js 的一个类 curses 库。更底层，控制力更强。
- **[Clack](https://github.com/bombshell-dev/clack)** —— 漂亮的提示和加载动画。适合更简单的 CLI。
- **[@clack/prompts](https://github.com/bombshell-dev/clack)** —— 交互式提示（选择、确认、加载动画），开箱即用就很精致。
- **[Charm](https://charm.sh/)** —— 基于 Go 的 TUI 工具（Bubble Tea、Lip Gloss）。如果你比起 TypeScript 更喜欢 Go。

比如用 Ink，你的权限对话框可以长这样：

```tsx
function PermissionDialog({ toolName, input, onAllow, onDeny }) {
  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text bold>The agent wants to use: {toolName}</Text>
      <Text color="gray">{JSON.stringify(input)}</Text>
      <Box gap={2}>
        <Text color="green">[y] Allow</Text>
        <Text color="red">[n] Deny</Text>
        <Text color="blue">[a] Always allow</Text>
      </Box>
    </Box>
  );
}
```

TUI 是可选的。用 readline 智能体照样能跑。但一个好的 TUI 能让体验好得多。

## 扩展的点子

如果你想在现有基础上继续构建：

- **一个待办/任务工具**，让模型能跟踪自己做完了什么、还剩什么
- **Git 工具**（status、diff、commit、log），让模型能管理自己的改动
- **一个 diff 查看器**，每次编辑后以可读的方式精确展示改了什么
- **自定义工具插件**，让用户能加自己的工具，而不用改动智能体本身
- **IDE 集成**，通过 VS Code 扩展或 JetBrains 插件

## 核心理念

这份指南里的一切，都归结到一个简单的理念：

```
while (true) {
  response = callModel(messages)
  if (response has tool calls) {
    results = executeTools(response.toolCalls)
    messages.push(response, results)
    continue
  }
  break
}
```

模型的输出变成它自己的输入。循环是笨的，模型是聪明的。其他一切，不过是让这个循环更快、更安全、更能干而已。

现在，去构建点什么吧。
