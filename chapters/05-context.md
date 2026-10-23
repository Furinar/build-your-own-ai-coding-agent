# 第 5 章：上下文

## 问题

用户和智能体已经协作了一阵子。五轮之前，智能体读过 `LoginPage.tsx`。现在用户说：“把标题改成 30px。”

哪个标题？在哪个文件里？用户没说。但用户和智能体都知道答案，因为他们刚才就在一起改登录页。

模型是怎么知道的？

## 什么是上下文？

LLM 没有记忆。每次调用 API，模型都是从零开始的。它不记得上一次调用。那对话是怎么进行下去的呢？

答案是：每次调用都把整段对话历史发过去。所有之前的用户消息、所有助手回复、所有工具调用和结果，全都发过去。这就是**上下文**。它不过是你传给 API 的那个 messages 数组。

模型读完整个上下文，然后生成回复，就好像第一次看到这整段对话一样。看上去像是模型“记得”，其实它只是每一轮都把完整对话重新读了一遍。

上下文有个大小上限，叫**上下文窗口**。对大多数模型来说，这个值在 100,000 到 200,000 token 之间。如果你的对话超出了这个范围，API 调用就会失败。这个问题我们下一章再处理。

## 实例：“把标题改成 30px”

下面是一段已经进行了好几轮的对话：

```
Turn 1  [user]:    "帮我做一个登录页"
Turn 2  [assistant]: [tool] list_files(...)
Turn 3  [tool_result]: src/pages/LoginPage.tsx, src/components/Header.tsx...
Turn 4  [assistant]: [tool] read_file("src/pages/LoginPage.tsx")
Turn 5  [tool_result]: (完整文件内容，包含一个 <h1 className="text-2xl">)
Turn 6  [assistant]: "我看到你的登录页了。它有一个标题、一个表单……"
Turn 7  [user]:    "把标题改成 30px"
```

当模型处理第 7 轮时，它看到了什么？它看到了**全部**。从第 1 轮到第 7 轮，整段对话，包括第 5 轮里的完整文件内容。

模型不需要重新搜索。它不需要重新读文件。文件内容已经在它的上下文里了。它知道：

- 我们正在改 `LoginPage.tsx`（从对话脉络得知）
- 标题当前用的是 `text-2xl`（从第 5 轮的文件内容得知）
- 用户想要 30px（从第 7 轮得知）

所以它这样做：

```
Turn 8  [assistant]: [tool] edit_file({
          file_path: "src/pages/LoginPage.tsx",
          old_string: "text-2xl",
          new_string: "text-[30px]"
        })
```

一次工具调用。不用搜索，不用读取。上下文把一切都带了过来。

## 原理：完整对话重放

智能体循环每次调用 API，都会把**整段对话历史**发过去：

```typescript
const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  system: SYSTEM_PROMPT,
  tools: apiTools,
  messages: conversationHistory,  // <-- 全部内容，每一轮
});
```

`conversationHistory` 数组里装着每一条用户消息、每一次助手回复、每一次工具调用和每一个工具结果。全都在里面，每一轮都在。

这意味着模型可以完整访问：

- 它读过哪些文件（以及文件内容）
- 它做过哪些修改
- 它运行过哪些命令（以及输出）
- 用户说过什么
- 它自己回了什么

这个做法简单且正确。模型看到了一切，可以基于完整的上下文来做决策。

## 消息结构

来看看几轮之后，真实的对话数组长什么样：

```typescript
[
  // 第 1 轮：用户消息
  { role: "user", content: "帮我做一个登录页" },

  // 第 2 轮：助手调用工具
  { role: "assistant", content: [
    { type: "text", text: "我来看一下项目结构。" },
    { type: "tool_use", id: "toolu_1", name: "list_files", input: { directory: "src" } }
  ]},

  // 第 3 轮：工具结果
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "src/App.tsx\nsrc/pages/LoginPage.tsx\n..." }
  ]},

  // 第 4 轮：助手读取文件
  { role: "assistant", content: [
    { type: "tool_use", id: "toolu_2", name: "read_file", input: { file_path: "src/pages/LoginPage.tsx" } }
  ]},

  // 第 5 轮：文件内容
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_2", content: "1\timport React from 'react';\n2\t..." }
  ]},

  // 第 6 轮：助手文本回复
  { role: "assistant", content: [
    { type: "text", text: "我看到你的登录页了。它有一个标题、一个表单……" }
  ]},

  // 第 7 轮：后续用户消息
  { role: "user", content: "把标题改成 30px" },
]
```

模型看到第 7 轮时，能访问上面所有的轮次。文件内容就在第 5 轮里。这就是为什么它能回答后续问题，而不用重新读文件。

## 成本问题

把所有东西都发过去是有代价的。对话每一轮都在变长。而每个 token 你都要付费。

设想一段 10 轮的对话，智能体读了 5 个文件：

```
Turn 1:   用户消息                         ~20 tokens
Turn 2:   工具调用 (list_files)            ~50 tokens
Turn 3:   工具结果 (文件列表)              ~200 tokens
Turn 4:   工具调用 (read_file)             ~50 tokens
Turn 5:   工具结果 (文件内容)              ~2,000 tokens
Turn 6:   工具调用 (read_file)             ~50 tokens
Turn 7:   工具结果 (文件内容)              ~3,000 tokens
Turn 8:   工具调用 (edit_file)             ~100 tokens
Turn 9:   工具结果 (编辑确认)              ~20 tokens
Turn 10:  助手文本回复                     ~200 tokens
                                    合计: ~5,690 tokens
```

如果你跑过前面的例子，大概已经注意到成本了。其中大头来自工具结果每一轮都被重复发送。而这还只是一次用户交互。下一条用户消息时，我们又会把这 5,690 token 全部再发一遍，加上新消息。再下一轮又来一遍。

到第 20 轮，你每次 API 调用可能就要发 30,000 token。到第 50 轮，可能已经到 100,000+ 了。每读一个文件，都会加上几千个 token，而且它们在接下来的整段对话里一直赖着不走。

这不只是成本问题。还有一道硬性上限：模型的上下文窗口。一旦超出，API 调用就会失败。

## 消息归一化

把消息发给 API 之前，你应该先清理一下，去掉 API 不需要的东西，确保格式正确。

基本的归一化：

```typescript
function normalizeMessages(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  return messages.filter((msg) => {
    // 移除空消息
    if (typeof msg.content === "string" && msg.content.trim() === "") {
      return false;
    }
    return true;
  });
}
```

在生产级智能体里，归一化要复杂得多。下面是它常处理的几类情况：

- **孤立的工具调用。** 如果模型调用了工具，但执行被打断了（用户取消、报错、超时），你就会有一个 `tool_use` 块却没有与之匹配的 `tool_result`。API 会拒绝这种情况。归一化会插入一个合成的错误结果，比如 `"[工具结果因中断而缺失]"`，让消息保持合法。

- **连续的同角色消息。** 有些 API 要求消息在 `user` 和 `assistant` 之间交替。如果两条用户消息挨到了一起（比如一个工具结果后面紧跟一条新的用户提示），就需要把它们合并成一条。

- **过大的工具结果。** 一次返回了 10,000 行的文件读取，20 轮之前就在对话里，到现在还在。归一化可以把它截断，或者换成一段摘要。（下一章会详细讲这个。）

眼下，基本的过滤就够了。需要的时候我们再加更多。

## 还缺什么

对话会无限制地增长。它迟早会超出上下文窗口，API 调用就会失败。我们需要一种办法，在不丢失重要信息的前提下压缩旧消息。

这正是下一章的主题：上下文压缩。

## 运行示例

```bash
npm run example:05
```

试一段多轮对话：
1. “sample-project 里有哪些文件？”（智能体读取文件列表）
2. “读一下 Button 组件”（智能体读取文件）
3. “把颜色改成红色”（文件已经在智能体的上下文里了，所以它可以直接改）

注意第 3 步并不需要重新读文件。上下文把信息带了过来。
