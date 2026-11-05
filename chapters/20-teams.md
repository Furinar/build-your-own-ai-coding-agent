# 第 20 章：团队消息、审批与 Worktree

本章完整示例：[20-with-teams.ts](../examples/20-with-teams.ts)。请先读前一章，再沿着本文件中的 `createAgent → execute → agentLoop` 路径阅读。

## 先把协作拆成三种状态

任务板回答谁负责什么，邮箱回答谁对谁说了什么，worktree 回答代码在哪个目录修改。三者互相引用，但不能混为一份对话。这里完整复制第 17 章 TaskBoard，使你仍能在单文件内追踪领取和完成逻辑。

## 消息需要持久投递和显式确认

TeamMailbox 使用 .team/mail.json 和目录锁。team_inbox 只读未确认消息，team_ack 在处理之后确认；重启不会丢掉未读消息。发送工具只允许当前 TEAM_MEMBER 身份，模型不能在参数里冒充其他成员。这个本地身份依赖进程环境，没有网络认证能力。

## 批准必须属于这次任务版本

review_request 记录 id 和领取后的 version；另一个终端里的成员收到请求、审查实际代码后调用 review_approve。task_complete 检查批准者不是领取者，批准绑定同一个任务版本，并让 TaskBoard 再校验领取者和版本。旧批准无法授权后来变更的任务；这里审批绑定任务状态，不绑定代码内容哈希，修改代码后应重新建立审查任务。

## 两个终端才是两个独立 Agent

可以分别用 TEAM_MEMBER=alice 和 TEAM_MEMBER=bob 启动 example:20。alice 领取并请求 bob 审查；bob 用 team_inbox 查看并批准；alice 才能完成。team_send 只写邮箱，不会启动子代理，也不会声称接收者已经工作。

## 工作目录决定隔离是否成立

保持两个协作终端在同一仓库根目录，分别启动：

```bash
TEAM_MEMBER=alice pnpm run example:20
TEAM_MEMBER=bob pnpm run example:20
```

alice 使用 `task_create → task_claim → review_request`；bob 使用 `team_inbox → 审查实际文件 → review_approve → team_ack`；alice 再使用 `task_complete`。批准是工具操作，普通 `team_send` 中写“批准了”不会产生审批记录。

worktree_create 调用真实 git worktree add --detach，返回 .worktrees/<member>。worktree_status 明确把 cwd 设为这个目录。若要让完整 Agent 在新工作树修改文件，需进入该目录再启动示例，或代码中用 createAgent({ cwd: returnedDirectory }) 创建独立实例；只换提示词没有隔离效果。共享协作状态的两个终端应先在同一仓库根目录启动本章。

## 亲手验证与边界

--demo 验证消息重启可读以及旧版本批准无效；自动测试另外在临时 Git 仓库创建 worktree 并校验命令 cwd。示例不自动提交、合并或删除工作树。练习结束可查看 git worktree list，保留有修改的工作树；删除干净练习树时用 git worktree remove <目录>。相同成员名只能创建一次，以免覆盖已有文件。

## 运行入口

在仓库根目录完成依赖安装并配置 `.env` 后运行：

```bash
pnpm run example:20 -- --help
pnpm run example:20 -- --prompt "查看团队任务和我的收件箱。"
```

不传 `--prompt` 则进入交互终端，输入 `q` 或 `exit` 退出。工具具有实际读写能力；建议复制示例到练习目录，或为导出的 `createAgent` 传入临时 `cwd`。

机制演示不需要 API key，可直接运行：

```bash
pnpm exec tsx examples/20-with-teams.ts --demo
```

项目的 `pnpm run example:20` 脚本仍读取 `.env`，因此没有环境文件时请使用上面的直接入口。

## 阅读检查点

- 在 `tools` 数组中找出本章新增的工具及其模型 Schema。
- 在 `execute` 中找出参数校验、实际执行和错误转成 `tool_result` 的路径。
- 在 `agentLoop` 中确认模型响应先写入历史，每个 `tool_use_id` 都有对应结果。
- 区分内存状态与磁盘状态，说明退出后哪些内容仍会保留。
- 故意制造一次失败，核对终端、工具结果与真实状态是否一致。

[上一章](19-cron.md) · [下一章：通过 MCP 发现外部工具](21-mcp.md)
