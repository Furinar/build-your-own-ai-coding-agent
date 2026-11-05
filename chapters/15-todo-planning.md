# 第 15 章：待办管理

本章完整示例：[15-with-todos.ts](../examples/15-with-todos.ts)。请先读前一章，再沿着本文件中的 `createAgent → execute → agentLoop` 路径阅读。

## 为什么模型需要一个可见清单

长任务中，对话历史能记录发生过什么，却不容易看清接下来做什么。待办工具让模型把计划写成结构化状态，终端和停止检查都能读取同一份清单。它不负责自动执行计划，选择行动的仍然是 agentLoop 中的模型。

## 状态约束应由执行器负责

TodoList.replace 先校验全部输入，再更新内存；校验失败时旧清单不变。id 不能重复，同时只能有一个 in_progress 项；已有项不能删除，completed 不能倒退。这些规则让“把剩余任务删掉”无法伪装成完成。最多 20 项也迫使模型把计划保持在可读的规模。

## 停止检查如何接回循环

模型不再请求工具时，todos.pending() 检查是否还有工作。如果有，就把清单作为下一条 user 消息送回模型，继续同一个循环。每次继续仍消耗一轮，maxTurns 防止待办无法完成时无限运行。实际产品可以另加 blocked 状态；本章使用轮次上限暴露阻塞，而不把阻塞当作完成。

## 亲手验证

循环的新增控制点只有这一段：

```typescript
if (todos.pending().length) {
  messages.push({
    role: "user",
    content: "仍有未完成待办，请继续或说明阻塞原因：" + JSON.stringify(todos.pending()),
  });
  continue;
}
```

它位于“模型没有工具请求”的分支。`continue` 重新进入原循环，没有创建另一个 Agent。

运行下面的任务，终端应先出现 todo_write，再出现 read_file，最后清单变为 completed。接着要求同时设置两个 in_progress 项，模型应该收到 Error。用测试注入固定模型时，还能验证错误没有改变原清单。

## 边界与下一步

清单只保存在当前进程，退出后不会恢复。它适合单个 Agent 的短计划。第 17 章会把任务写到磁盘，并加入依赖和领取规则；不要把当前清单理解成跨进程任务系统。

## 运行入口

在仓库根目录完成依赖安装并配置 `.env` 后运行：

```bash
pnpm run example:15 -- --help
pnpm run example:15 -- --prompt "创建一个读取 README.md 的待办，执行并更新为已完成。"
```

不传 `--prompt` 则进入交互终端，输入 `q` 或 `exit` 退出。工具具有实际读写能力；建议复制示例到练习目录，或为导出的 `createAgent` 传入临时 `cwd`。

## 阅读检查点

- 在 `tools` 数组中找出本章新增的工具及其模型 Schema。
- 在 `execute` 中找出参数校验、实际执行和错误转成 `tool_result` 的路径。
- 在 `agentLoop` 中确认模型响应先写入历史，每个 `tool_use_id` 都有对应结果。
- 区分内存状态与磁盘状态，说明退出后哪些内容仍会保留。
- 故意制造一次失败，核对终端、工具结果与真实状态是否一致。

[上一章](14-hooks.md) · [下一章：渐进加载 Skills](16-skills.md)
