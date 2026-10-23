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

一个命令行工具，它借助 LLM 来读取、搜索、编辑文件并执行命令。到教程结束时，你的助手会具备流式输出、权限控制、子代理、上下文压缩和并发工具执行等能力。这些正是 Claude Code、Cursor 以及其他 AI 编程助手背后的同一套核心思路。

## 前置条件

- Node.js 18 及以上
- 一个 Anthropic API key（[在这里获取](https://console.anthropic.com/)）——示例里用到，但这些概念对任何 LLM 都适用
- 基础的 TypeScript 知识

## 环境准备

```bash
npm install
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

## 运行示例

每一章都有一个对应的示例文件。这样运行：

```bash
npm run example:01
npm run example:02
# ……以此类推
```

示例是层层递进的。从 01 开始，一路往上做。

## 示例项目

`sample-project/` 文件夹里是一个小型 React 应用，供助手操作。示例会在这些文件上做读取、搜索和编辑。
