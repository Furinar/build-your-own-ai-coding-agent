# 第 16 章：渐进加载 Skills

本章完整示例：[16-with-skills.ts](../examples/16-with-skills.ts)。请先读前一章，再沿着本文件中的 `createAgent → execute → agentLoop` 路径阅读。

## 让知识按需进入上下文

把所有操作指南放进 system 会很快撑满上下文，也让模型分不清哪些内容相关。Skill 分成两层：启动时只读取 YAML 中的 name 和 description；任务匹配时再用 load_skill 获取全文。目录扫描发生在本地，模型决定要加载哪份指南。

## 一个 Skill 就是目录中的说明文件

仓库附带 skills/code-review/SKILL.md 和 references/checklist.md。前者说明何时使用、如何审查；后者是可选的详细清单。这里使用真正的 YAML 解析器，支持多行 description，并拒绝无效元数据和重名 Skill。仅用正则提取 name 会丢失 YAML 的语义。

## 工具结果才是加载入口

样例的文件结构是：

```text
skills/
└── code-review/
    ├── SKILL.md
    └── references/
        └── checklist.md
```

头部的多行描述是合法 YAML：

```yaml
---
name: code-review
description: |
  审查 TypeScript Agent 的工具执行与状态管理。
  当用户要求 review 或检查 Agent 代码时使用。
---
```

SkillLibrary.catalog 返回短目录；load 返回原文，随后由 agentLoop 将它配对成 tool_result。Skills 没有隐藏的执行通道，也不会注册任意 JavaScript。即使说明声称有更高权限，实际文件操作仍经过本文件的 execute。

## 逐层加载附件

说明可以指向 references/checklist.md。模型应使用 read_file 读取 skills/code-review/references/checklist.md；不是从仓库根直接读取 references/checklist.md。暂时不需要的参考资料保持在磁盘上，这就是第二次按需加载。

## 亲手验证与边界

运行示例任务，观察 list_skills 或初始化目录、load_skill、read_file 的顺序。没有 skills 目录时目录为空，普通文件任务仍可运行。当前扫描会读取说明文件以解析头部，但只把元数据送给模型；大规模目录可额外做索引缓存。外部 Skill 应按不可信文本处理，本例也没有建立文件系统沙箱。

## 运行入口

在仓库根目录完成依赖安装并配置 `.env` 后运行：

```bash
pnpm run example:16 -- --help
pnpm run example:16 -- --prompt "使用 code-review Skill，读取 examples/15-with-todos.ts 并给出审查意见。"
```

不传 `--prompt` 则进入交互终端，输入 `q` 或 `exit` 退出。工具具有实际读写能力；建议复制示例到练习目录，或为导出的 `createAgent` 传入临时 `cwd`。

## 阅读检查点

- 在 `tools` 数组中找出本章新增的工具及其模型 Schema。
- 在 `execute` 中找出参数校验、实际执行和错误转成 `tool_result` 的路径。
- 在 `agentLoop` 中确认模型响应先写入历史，每个 `tool_use_id` 都有对应结果。
- 区分内存状态与磁盘状态，说明退出后哪些内容仍会保留。
- 故意制造一次失败，核对终端、工具结果与真实状态是否一致。

[上一章](15-todo-planning.md) · [下一章：持久任务与依赖图](17-task-board.md)
