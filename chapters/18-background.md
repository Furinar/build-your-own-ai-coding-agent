# 第 18 章：后台命令与通知

本章完整示例：[18-with-background.ts](../examples/18-with-background.ts)。请先读前一章，再沿着本文件中的 `createAgent → execute → agentLoop` 路径阅读。

## 启动成功和任务成功是两件事

execSync 会让循环停在命令上。BackgroundJobs.start 使用 spawn，返回 id 后模型可以继续读取文件。每个任务有独立状态和受限输出缓冲；只有 close 事件和退出码才决定 completed 或 failed。

## 把通知送回原来的循环

子进程完成时把摘要放进 notices，下一次模型请求前 drain 一次并加入 user 消息。队列只负责桥接两个时间线，不会直接递归调用 agentLoop，因此不会产生两个同时修改 messages 的循环。完整输出通过 background_status 读取。

## 如何等待而不让模型空转

命令结束事件只写队列，循环在请求模型前读取：

```typescript
const notices = background.drain();
if (notices.length) {
  messages.push({ role: "user", content: "后台通知：" + notices.join("\n") });
}
```

执行流是 `spawn → 立即返回 id → 继续模型轮次`，通知流是 `close → notices → 下一次模型请求`。两条路径在消息历史中汇合。

background_wait 等待当前运行任务的 done Promise。Stop 检查仍在运行的任务，提示模型等待或取消；maxTurns 仍限制模型反复轮询。新通知若在模型请求过程中到达，将在下一轮读取；最后一个纯文本响应之后到达的通知，会在下一次用户提交时读取。

## 退出要处理进程树

shell 命令可能再启动其他进程，只终止 shell 会留下测试程序。macOS/Linux 使用独立进程组，cancel 先发送 SIGTERM，500 毫秒后升级 SIGKILL，并等待 close。Windows 使用 child.kill，覆盖范围更窄。close 会取消剩余任务；不应让后台子进程在交互终端退出后继续占资源。

## 亲手验证与边界

运行 --demo 应得到输出 42、exitCode 0 和一条完成通知。测试另外验证失败退出码、输出截断和取消一个长任务。本例接受真实 shell 命令，应在练习目录执行；它没有第 7 章的交互权限，也不是跨重启的作业系统。

## 运行入口

在仓库根目录完成依赖安装并配置 `.env` 后运行：

```bash
pnpm run example:18 -- --help
pnpm run example:18 -- --prompt "后台执行 node -e 'console.log(42)'，等待结束并读取输出。"
```

不传 `--prompt` 则进入交互终端，输入 `q` 或 `exit` 退出。工具具有实际读写能力；建议复制示例到练习目录，或为导出的 `createAgent` 传入临时 `cwd`。

机制演示不需要 API key，可直接运行：

```bash
pnpm exec tsx examples/18-with-background.ts --demo
```

项目的 `pnpm run example:18` 脚本仍读取 `.env`，因此没有环境文件时请使用上面的直接入口。

## 阅读检查点

- 在 `tools` 数组中找出本章新增的工具及其模型 Schema。
- 在 `execute` 中找出参数校验、实际执行和错误转成 `tool_result` 的路径。
- 在 `agentLoop` 中确认模型响应先写入历史，每个 `tool_use_id` 都有对应结果。
- 区分内存状态与磁盘状态，说明退出后哪些内容仍会保留。
- 故意制造一次失败，核对终端、工具结果与真实状态是否一致。

[上一章](17-task-board.md) · [下一章：定时任务与成功确认](19-cron.md)
