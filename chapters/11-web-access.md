# 第 11 章：访问网络

本章的 `web_search` 依赖 Anthropic 服务端搜索能力，兼容网关不一定提供。示例只有收到 `web_search_tool_result` 才把输出作为搜索结果；仅返回普通文本时会报告不支持，而不会声称已经搜索。`web_fetch` 读取已知 URL，不依赖服务端搜索。

## 问题所在

我们的智能体只能看到本地文件。如果用户问“useEffect 这个 hook 怎么用？”，智能体可以在代码库里搜例子，但没法去查 React 官方文档。如果冒出一个它从没见过的报错，它也没法上网搜解决办法。

开发者时时刻刻都在查网络：文档、Stack Overflow、博客、API 参考。一个不能访问网络的智能体，就像一个没有浏览器的开发者。

## 什么是访问网络？

对智能体来说，访问网络意味着两个工具：

1. **抓取（Fetch）**：给它一个 URL，返回页面内容。就像打开一个具体的链接。
2. **搜索（Search）**：给它一个查询词，返回一组带标题和 URL 的结果。就像在搜索引擎里输入关键词。

模型用搜索找到相关页面，再用抓取去读它们——跟你平时的做法一模一样。

## 演练：“useEffect 怎么用？”

```
第 1 轮：
  [tool] web_fetch({
    url: "https://react.dev/reference/react/useEffect",
    prompt: "Explain how useEffect works with examples"
  })
  [result] "useEffect is a React Hook that lets you synchronize a component
            with an external system. Basic usage: useEffect(() => { ... }, [deps]).
            The first argument is the setup function..."

第 2 轮：
  [text] "useEffect lets you run side effects in your components.
          Here is how it works: ..."
```

智能体抓取了 React 文档，提取出相关信息。用户得到的是一个基于真实文档的答案，而不只是模型训练数据里的东西。

## 构建抓取工具

抓取工具接收一个 URL，把页面内容以文本形式返回。但这里有几个问题要解决：

**HTML 很杂乱。** 一个网页里塞满了导航、广告、脚本、样式。模型一样都不需要。我们得把 HTML 转成干净的文本。

**页面可能很大。** 有些文档页面有 10 万多个字符。把这些全塞进上下文纯属浪费 token。我们得做截断。

**模型需要聚焦。** 与其把整个页面内容发过去，不如告诉模型“这是页面，把关于 X 的部分提取出来”。这样主模型拿到的是一份聚焦的摘要，而不是一大堆文字。

### 把 HTML 转成文本

最简单的办法是用正则去掉 HTML 标签：

```typescript
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
```

对简单页面有用，但会丢掉结构。标题、列表、代码块全都变成了扁平的文本。

更好的办法是用像 [Turndown](https://github.com/mixmark-io/turndown) 这样的库把 HTML 转成 Markdown。它保留了文档结构，让模型能正确地阅读：

```typescript
import Turndown from "turndown";
const turndown = new Turndown();

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}
```

一个依赖，一行代码。标题还是标题，代码块还是代码块，链接还是链接。生产级智能体用的就是这个。我们的示例也用 Turndown，因为它简单，效果又好得多。

### 基础抓取工具

```typescript
const MAX_WEB_CONTENT = 50_000;

const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "抓取一个网页，并根据 prompt 提取内容。" +
    "返回页面里相关的内容。",
  inputSchema: z.object({
    url: z.string().describe("要抓取的 URL"),
    prompt: z.string().describe("要从页面里提取什么"),
  }),
  async call(input) {
    const url = input.url as string;
    const prompt = input.prompt as string;

    // 1. 抓取页面
    const response = await fetch(url);
    if (!response.ok) {
      return `错误：HTTP ${response.status} ${response.statusText}`;
    }
    const html = await response.text();

    // 2. 把 HTML 转成 markdown
    const text = htmlToMarkdown(html);

    // 3. 过长就截断
    const truncated = text.length > MAX_WEB_CONTENT
      ? text.slice(0, MAX_WEB_CONTENT) + "\n[已截断]"
      : text;

    return truncated;
  },
};
```

这段代码抓取页面、转成文本、再截断。模型拿到的是它可以推理的、可读的内容。

### 用次级模型做提取

基础版会把整个页面（最多 50000 个字符）发给主模型。这能用，但浪费 token，因为页面里大部分内容都和用户问的东西无关。

生产级智能体用一次**次级模型调用**来解决这个问题。它们把页面内容连同“把关于 X 的部分提取出来”的提示词一起发给一个便宜又快的模型，再把摘要返回给主模型：

```typescript
async call(input) {
  const url = input.url as string;
  const prompt = input.prompt as string;

  // ... 抓取并剥离 HTML（和前面一样）...

  // 用一个便宜的模型来提取相关内容
  const extraction = await client.messages.create({
    model: "claude-haiku-4-5-20251001",  // 便宜又快
    max_tokens: 2048,
    system: "根据用户的 prompt，从这个网页里提取相关信息。保持简洁。",
    messages: [
      {
        role: "user",
        content: `Prompt: ${prompt}\n\nPage content:\n${truncated}`,
      },
    ],
  });

  const extractedText = extraction.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return extractedText;
}
```

现在主模型拿到的是一份聚焦的、200 到 500 token 的摘要，而不是 50000 个字符的页面内容。这既省 token，又让上下文保持干净。

代价是：每次抓取多一次 API 调用。但用的是便宜模型，跟省下的 token 相比，这点成本不算什么。

## 缓存

智能体在一次会话里可能会多次抓取同一个 URL。也许它在第 3 轮抓过 React 文档，到第 10 轮又想引用一次。同一个页面抓两遍是浪费。

一个简单的内存缓存就能解决：

```typescript
const urlCache = new Map<string, string>();

async call(input) {
  const url = input.url as string;

  // 先查缓存
  const cached = urlCache.get(url);
  if (cached) {
    return cached;
  }

  // ... 抓取并处理 ...

  // 存入缓存
  urlCache.set(url, result);
  return result;
}
```

这个缓存只在会话期间有效。智能体重启后，缓存就空了。这样挺好，因为网页内容会变，你不会想让陈旧的缓存页面永远留着。

## 网络搜索

搜索比抓取更棘手。你需要一个搜索后端。有两种办法：

- **外部 API**：用像 Google Custom Search、Bing Search 或 Brave Search 这样的搜索 API。它们需要单独的 API key，而且有速率限制。
- **内置的服务端搜索**：有些 LLM 提供方把网络搜索作为内置功能。你在 API 调用里传一个特殊的工具定义，由提供方在它们那边执行搜索。

我们的示例用的是 Anthropic SDK，它支持内置网络搜索。你在 API 调用里传一个 `web_search` 工具，Claude 就会在服务端搜索网络。不需要额外的 API key。

思路很简单：不让我们的智能体自己去调搜索工具，而是向 Claude 另外发一次开启了网络搜索工具的 API 调用。Claude 执行搜索并返回结果，然后我们的智能体解析这些结果。

```typescript
const webSearchTool: Tool = {
  name: "web_search",
  description: "搜索网页，返回带标题和 URL 的结果。",
  inputSchema: z.object({
    query: z.string().describe("搜索查询词"),
  }),
  async call(input) {
    const query = input.query as string;

    // 另外发一次 API 调用，带上服务端网络搜索工具
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: "执行网络搜索并返回结果。",
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: `搜索网页：${query}` }],
    });

    // 从响应里提取搜索结果和文本
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === "web_search_tool_result") {
        if (Array.isArray(block.content)) {
          for (const result of block.content) {
            parts.push(`- ${result.title}: ${result.url}`);
          }
        }
      } else if (block.type === "text") {
        parts.push(block.text);
      }
    }

    return parts.join("\n") || "没有找到结果。";
  },
};
```

模型拿回标题、URL，有时还有一段文本摘要。然后它就可以对任何看起来相关的 URL 用 `web_fetch`。搜索负责找页面，抓取负责读页面。

如果你用的是别的 LLM 提供方，就换成它们对应的功能。OpenAI 有类似的服务端搜索功能。或者用像 Brave Search 这样的外部 API，自己解析返回的 JSON。

## 权限

访问网络应该征求许可。你不会想让智能体悄无声息地去抓一些乱七八糟的 URL——它可能把你的代码发给某个外部服务，或者从一个恶意站点抓取内容。

```typescript
checkPermissions(input) {
  return "ask";  // 抓取前总是先问
}
```

生产级智能体做得更细致。它们维护一份预先批准的域名清单（比如官方文档站点），这些会跳过权限询问。其他域名则总是要问：

```typescript
const PREAPPROVED_HOSTS = new Set([
  "react.dev",
  "developer.mozilla.org",
  "docs.python.org",
  "doc.rust-lang.org",
  "go.dev",
  // ... 其他可信的文档站点
]);

checkPermissions(input) {
  const hostname = new URL(input.url as string).hostname;
  if (PREAPPROVED_HOSTS.has(hostname)) {
    return "allow";  // 可信文档站点，不用问
  }
  return "ask";  // 未知域名，问问用户
}
```

这样一来，抓取 `react.dev` 是自动的，而抓取 `random-site.com` 就需要批准。

## 还缺什么

我们的智能体活在当下。一关掉它，一切都没了——对话、读过的文件、做过的决定。下一章我们会加上持久化，让智能体能保存自己的状态，从上次停下的地方接着来。

## 运行示例

```bash
npm run example:11
```

试试：
- “抓取 https://example.com 并告诉我它写了什么”
- “上网搜索 React useEffect 怎么用”
- “Anthropic 首页上有什么？”（它会抓取并总结）
