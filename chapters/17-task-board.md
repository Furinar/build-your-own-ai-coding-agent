# 第 17 章：持久任务与依赖图

本章完整示例：[17-with-task-board.ts](../examples/17-with-task-board.ts)。请先读前一章，再沿着本文件中的 `createAgent → execute → agentLoop` 路径阅读。

## 从清单到可以领取的工作

当两个 Agent 同时做事，仅靠第 15 章的内存清单无法判断谁负责哪一项。TaskBoard 把状态存到 .tasks/board.json，并为每个任务记录 dependsOn、owner 和 version。模型通过四个工具创建、查看、领取、完成；具体推进顺序仍由模型选择。

## 依赖图为什么不会成环

task_create 只允许依赖已有任务，而且不提供改依赖的工具。这样每条边都指向更早创建的节点，天然形成 DAG。领取前检查全部依赖已 completed，未完成的前置任务会让领取失败。若以后支持编辑依赖，就必须补充图遍历检测环。

## 锁必须覆盖读取、判断和写入

只在 writeFile 时加锁不够：两个进程可能都先读到 pending。transaction 使用 mkdir 排他创建 board.lock，把读取、状态判断、原子替换文件放在同一个临界区；竞争失败的进程收到可重试错误。snapshot 无需锁，因为文件通过同目录临时文件 rename 发布。

## 版本解决迟到的更新

整个领取流程都在同一临界区：

```mermaid
flowchart LR
  A[排他创建 board.lock] --> B[读取任务]
  B --> C[检查 pending 与依赖]
  C --> D[写入 owner 并增加 version]
  D --> E[原子替换 board.json]
  E --> F[释放锁]
```

任意校验失败都会经过 `finally` 释放锁，文件保持更新前状态。锁冲突不会被当作领取成功。

claim 返回版本；complete 同时检查 owner 和 version。旧调用无法覆盖新状态，也不能替另一个领取者完成任务。模型必须使用工具真实返回的版本，而不能猜数字。已领取任务不会自动转交，本章刻意不加入租约回收。

## 恢复与故障边界

退出再启动，任务文件仍在。进程若在持锁时被强杀，board.lock 可能残留；先确认没有存活的写进程，再手动移除锁。不要按任意超时直接删锁，否则慢进程仍可能写入。running 任务同样需要人工核实后恢复；生产系统通常用带心跳的租约与数据库事务。

## 亲手验证

先运行 --demo：test 会被依赖阻塞，完成 build 后，重新创建 TaskBoard 的实例也能领取 test。再运行真实模型任务。测试还会启动两个独立进程争抢同一任务，验证最多一个领取成功。

## 运行入口

在仓库根目录完成依赖安装并配置 `.env` 后运行：

```bash
pnpm run example:17 -- --help
pnpm run example:17 -- --prompt "创建 read-demo 任务，领取后读取 README.md，再完成任务。"
```

不传 `--prompt` 则进入交互终端，输入 `q` 或 `exit` 退出。工具具有实际读写能力；建议复制示例到练习目录，或为导出的 `createAgent` 传入临时 `cwd`。

机制演示不需要 API key，可直接运行：

```bash
pnpm exec tsx examples/17-with-task-board.ts --demo
```

项目的 `pnpm run example:17` 脚本仍读取 `.env`，因此没有环境文件时请使用上面的直接入口。

## 阅读检查点

- 在 `tools` 数组中找出本章新增的工具及其模型 Schema。
- 在 `execute` 中找出参数校验、实际执行和错误转成 `tool_result` 的路径。
- 在 `agentLoop` 中确认模型响应先写入历史，每个 `tool_use_id` 都有对应结果。
- 区分内存状态与磁盘状态，说明退出后哪些内容仍会保留。
- 故意制造一次失败，核对终端、工具结果与真实状态是否一致。

[上一章](16-skills.md) · [下一章：后台命令与通知](18-background.md)
