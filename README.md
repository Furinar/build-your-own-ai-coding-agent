# 从零开始构建你自己的 AI 编程助手

有没有好奇过 Claude Code、Cursor 这类 AI 编程工具底层到底是怎么跑起来的？其实比你想的要简单得多。核心就是一个 while 循环、几个工具，再加上一些巧妙的小技巧。

这是一份手把手的教程，带你从零搭建出一个能用的 AI 编程助手。没有框架，没有魔法，只有 TypeScript 和一个 LLM API。每一章讲一个概念，说清楚它为什么这么设计，并配一个可以立刻运行的示例。

这些概念适用于任何支持工具调用的 LLM（Claude、GPT、Gemini 等）。我们的示例用的是 Claude 和 Anthropic SDK，但整套架构与具体厂商无关。

## 适合谁读

- 对 AI 编程工具内部原理感兴趣的开发者
- 想自己动手做 AI 开发工具的人
- 在动手中学得最快、而不只是看看的人

你只需要具备基础的 TypeScript 知识，以及一个 LLM API key。就这些。

## 你会做出什么

一个命令行工具，它借助 LLM 来读取、搜索、编辑文件并执行命令。基础篇覆盖流式输出、权限控制、子代理、上下文压缩和并发执行；进阶篇继续加入 Hooks、Skills、任务依赖、后台命令、定时任务、团队协作、MCP、工作流恢复和独立目标验收。

每章保留完整的 Agent 循环，并聚焦一个新概念。第 24 章提供组合示例，便于追踪这些能力如何接回同一个循环。

## 前置条件

- Node.js 22.9 及以上（示例启动命令使用 Node 的环境文件参数）
- 一个 Anthropic API key（[在这里获取](https://console.anthropic.com/)）——示例里用到，但这些概念对任何 LLM 都适用
- 基础的 TypeScript 知识

## 环境准备

```bash
pnpm install
cp .env.example .env
# 把你的 API key 填进 .env
```

## 章节

| # | 章节 | 你会学到什么 |
|---|---------|-------------------|
| 00 | [引言](chapters/00-introduction.md) | 我们要做什么，以及项目搭建 |
| 01 | [智能体循环](chapters/01-agentic-loop.md) | 驱动一切的 while(true) 核心 |
| 02 | [工具](chapters/02-tools.md) | 给模型装上眼睛和手 |
| 03 | [编辑工具](chapters/03-edit-tool.md) | AI 到底是怎么改文件的（比你想的简单） |
| 04 | [系统提示词](chapters/04-system-prompts.md) | 教会模型先搜索再编辑 |
| 05 | [上下文](chapters/05-context.md) | 对话历史如何让追问得以成立 |
| 06 | [上下文压缩](chapters/06-context-compression.md) | 上下文快满时让对话继续下去 |
| 07 | [权限](chapters/07-permissions.md) | 别让模型执行 rm -rf / |
| 08 | [子代理](chapters/08-subagents.md) | 把任务交给隔离的子代理 |
| 09 | [流式输出](chapters/09-streaming.md) | 逐 token 地展示回复 |
| 10 | [并发工具](chapters/10-concurrent-tools.md) | 让安全的工具并行执行 |
| 11 | [访问网络](chapters/11-web-access.md) | 抓取 URL 和搜索网页 |
| 12 | [持久化](chapters/12-persistence.md) | 保存对话和项目指令 |
| 13 | [接下来呢](chapters/13-whats-next.md) | 下一步往哪走 |
| 14 | [Hooks](chapters/14-hooks.md) | 在工具执行与停止检查处接入扩展 |
| 15 | [待办管理](chapters/15-todo-planning.md) | 用约束清单记录计划并检查收尾 |
| 16 | [Skills](chapters/16-skills.md) | YAML 元数据与按需加载操作指南 |
| 17 | [任务依赖](chapters/17-task-board.md) | 持久任务、跨进程领取与版本校验 |
| 18 | [后台任务](chapters/18-background.md) | 运行、通知、等待与取消命令 |
| 19 | [定时任务](chapters/19-cron.md) | UTC cron、成功确认与重启恢复 |
| 20 | [团队协作](chapters/20-teams.md) | 持久消息、版本审批与 Git worktree |
| 21 | [MCP](chapters/21-mcp.md) | 用官方 SDK 发现并调用外部工具 |
| 22 | [工作流](chapters/22-workflows.md) | 注册步骤、事件、预算与证据校验恢复 |
| 23 | [目标验收](chapters/23-goals.md) | 隔离上下文，用真实结果检查完成条件 |
| 24 | [综合示例](chapters/24-integrated-agent.md) | 把进阶能力组合进可见循环 |

## 运行示例

01～12、14～24 章各有一个独立示例文件；00 是环境准备，13 是基础篇回顾。这样运行：

```bash
pnpm run example:01
pnpm run example:02
# ……以此类推
pnpm run example:14 -- --prompt "读取 README.md"
pnpm run example:24 -- --help
```

示例是层层递进的。从 01 开始，一路往上做。

14～24 支持 `--prompt` 单次任务、`--help` 帮助和无参数交互模式。17～23 另有无需模型的 `--demo`（19 和 23 使用明确标注的注入回调演示）；例如：

```bash
pnpm exec tsx examples/21-with-mcp.ts --demo
pnpm run check
```

模型调用使用 Anthropic Messages 格式。兼容网关也必须支持对应协议；11 章的 `web_search` 额外要求服务端支持 Anthropic 网页搜索，普通工具调用可用不代表搜索可用。配置 `MODEL` 与 `FAST_MODEL` 时请使用网关实际可用的模型标识。

本轮已用 `trae-internal/deepseek-v4.1-flash` 完成 14～24 章真实模型烟测，37 次请求全部通过；类型检查与 24 项回归测试也已通过。具体范围和复现命令见 [验证记录](VERIFICATION.md)。

Skills 样例位于 `skills/code-review/`。任务与运行状态分别写入 `.tasks/`、`.runtime/`、`.team/`，Git worktree 使用 `.worktrees/`。练习工具具有真实文件和命令权限，复杂实验建议通过导出的 `createAgent({ cwd })` 在临时目录运行。综合示例展示教学组合，LSP、完整 TUI 和生产环境隔离仍是后续工程方向。

## 示例项目

`sample-project/` 文件夹里是一个小型 React 应用，供助手操作。示例会在这些文件上做读取、搜索和编辑。
