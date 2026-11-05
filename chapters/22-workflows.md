# 第 22 章：工作流、事件与恢复

本章完整示例：[22-with-workflows.ts](../examples/22-with-workflows.ts)。请先读前一章，再沿着本文件中的 `createAgent → execute → agentLoop` 路径阅读。

## 自由决策与固定步骤各有用途

agentLoop 让模型每轮选择下一步；工作流适合已经确定顺序的流程，比如写文件、检查内容。模型提供数据计划，WorkflowRunner 执行注册 action；计划不能包含任意源码。外层循环仍负责理解用户意图、调用 workflow_run 和处理错误。

## 先验证整份计划，再执行第一步

PlanSchema 检查 id、步骤数量和输入结构；run 在副作用前验证每个 action 是否注册，以及其 Zod 输入。第三步写错字段时，不会先运行前两步。示例 action 是 read、write、assert_file；新增执行能力要由开发者在 registry 中显式实现。

## 事件与结果分别存储

下面的计划是数据，不是可执行源码：

```json
{
  "id": "write-and-check",
  "steps": [
    { "id": "write", "action": "write", "input": { "file_path": "result.txt", "content": "OK" } },
    { "id": "check", "action": "assert_file", "input": { "file_path": "result.txt", "content": "OK" } }
  ]
}
```

开发者注册 `action` 的含义，模型只选择已注册名称并填参数。`id` 决定本次恢复记录，不能用同一 `id` 偷换计划。

每一步先写 started，成功后保存 output 和 completed，失败保存 failed。状态通过临时文件 rename 发布，并由目录锁避免重复并发执行。events 是可读的执行轨迹；completed 是恢复入口，不能仅凭事件中的一句成功文字来恢复。

## 缓存必须重新核对证据

同一 id 绑定完整计划哈希。恢复时，已完成步骤用 verify 核对真实文件，匹配才记录 cached 并跳过执行。外部改动使结果过期时会报错，不静默覆盖。这个缓存只复用同一次不可变工作流的结果；多个步骤若先读再修改同一个文件，恢复时旧 read 证据可能失效，此时应以新 id 重新规划。

## 失败重试也要消耗预算

attempts 在执行前落盘，失败也计数，跨重启不能靠重新启动绕过 maxCalls。每次 run 有 10 秒信号预算，action 应响应 signal；同步文件操作只能在操作间检查，任意不响应信号的第三方 action 无法被强制终止。生产系统可放入独立子进程限制执行。

## 恢复的边界与亲手验证

--demo 第二次运行应只产生 cached，外部修改文件后恢复应失败。测试还验证中途失败后仅重试未完成步骤、无效输入没有副作用和预算耗尽。进程崩溃在副作用成功与保存结果之间会重试，该注册表的 write 是幂等覆盖；不可逆外部操作必须自行设计幂等键或事务。

## 运行入口

在仓库根目录完成依赖安装并配置 `.env` 后运行：

```bash
pnpm run example:22 -- --help
pnpm run example:22 -- --prompt "用 workflow_run 创建 wf-demo 工作流，写入 wf-demo.txt 内容为 OK，再用 assert_file 核对。"
```

不传 `--prompt` 则进入交互终端，输入 `q` 或 `exit` 退出。工具具有实际读写能力；建议复制示例到练习目录，或为导出的 `createAgent` 传入临时 `cwd`。

机制演示不需要 API key，可直接运行：

```bash
pnpm exec tsx examples/22-with-workflows.ts --demo
```

项目的 `pnpm run example:22` 脚本仍读取 `.env`，因此没有环境文件时请使用上面的直接入口。

## 阅读检查点

- 在 `tools` 数组中找出本章新增的工具及其模型 Schema。
- 在 `execute` 中找出参数校验、实际执行和错误转成 `tool_result` 的路径。
- 在 `agentLoop` 中确认模型响应先写入历史，每个 `tool_use_id` 都有对应结果。
- 区分内存状态与磁盘状态，说明退出后哪些内容仍会保留。
- 故意制造一次失败，核对终端、工具结果与真实状态是否一致。

[上一章](21-mcp.md) · [下一章：独立目标验收](23-goals.md)
