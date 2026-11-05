# 第 19 章：定时任务与成功确认

本章完整示例：[19-with-cron.ts](../examples/19-with-cron.ts)。请先读前一章，再沿着本文件中的 `createAgent → execute → agentLoop` 路径阅读。

## 定时系统比 setInterval 多了什么

setInterval 只是唤醒进程，不能记住退出前的计划。CronJobs 把表达式、nextDue、remaining 和 lastError 写到 .runtime/cron.json，使用 cron-parser 计算下一次 UTC 到期时间。五字段与六字段 cron 都由库解析，示例中的六字段表达式可按秒触发。

## 成功确认决定状态推进

tick 找到到期任务，执行回调。只有回调成功，才减少 remaining 并推进 nextDue；失败保留原到期时刻，下次重试。每次调用提供 id:nextDue 作为 CRON_RUN_KEY，命令若有外部副作用，可用它实现幂等。

## 为什么仍然不是恰好执行一次

状态推进的顺序不能反过来：

```typescript
await execute(job.command, key);
job.remaining--;
job.nextDue = this.next(job.expression, now);
delete job.lastError;
atomicWrite(this.file, jobs);
```

若先减少次数再执行，崩溃可能让一次计划永久丢失。本例优先保留可重试的到期记录。

命令已经成功、但状态还没写盘时进程崩溃，恢复后会重跑同一时刻。这是至少一次语义，成功确认无法消除该窗口。生产系统需要让外部操作与确认共享事务，或由外部系统按 CRON_RUN_KEY 去重。错过多个时刻时，本例补跑一次，再从当前时间计算下一次，不回放全部历史。

## 处理并发和退出

同进程的并发 tick 共享 inFlight；不同进程由目录锁排他执行，锁覆盖命令执行和状态写盘。自动 ticker 每秒唤醒一次，unref 不单独维持进程。close 停止 ticker，并等待正在执行的回调；命令带 10 秒超时和退出取消信号。强杀留下的锁需要在确认无存活执行者后处理。

## CLI 存活才会自动执行

交互模式中可以创建 expression 为 */5 * * * * *、count 为 2 的短计划，观察通知。--prompt 完成后就退出，未来任务保留在磁盘，重新启动后才恢复检查。要全天运行，应交给系统服务托管本进程；本课程不安装系统服务。

## 亲手验证

--demo 不调用模型，模拟第一次失败，再用新 CronJobs 实例恢复成功；remaining 应只在成功后从 1 变为 0。真实模型练习可先用 cron_list 检查计划，再在交互模式创建只打印文字的限次命令。

## 运行入口

在仓库根目录完成依赖安装并配置 `.env` 后运行：

```bash
pnpm run example:19 -- --help
pnpm run example:19 -- --prompt "查看已有定时任务，解释下一次到期时间。"
```

不传 `--prompt` 则进入交互终端，输入 `q` 或 `exit` 退出。工具具有实际读写能力；建议复制示例到练习目录，或为导出的 `createAgent` 传入临时 `cwd`。

机制演示不需要 API key，可直接运行：

```bash
pnpm exec tsx examples/19-with-cron.ts --demo
```

项目的 `pnpm run example:19` 脚本仍读取 `.env`，因此没有环境文件时请使用上面的直接入口。

## 阅读检查点

- 在 `tools` 数组中找出本章新增的工具及其模型 Schema。
- 在 `execute` 中找出参数校验、实际执行和错误转成 `tool_result` 的路径。
- 在 `agentLoop` 中确认模型响应先写入历史，每个 `tool_use_id` 都有对应结果。
- 区分内存状态与磁盘状态，说明退出后哪些内容仍会保留。
- 故意制造一次失败，核对终端、工具结果与真实状态是否一致。

[上一章](18-background.md) · [下一章：团队消息、审批与 Worktree](20-teams.md)
