---
name: code-review
description: |
  审查 TypeScript Agent 的工具执行与状态管理。
  当用户要求 review 或检查 Agent 代码时使用。
---

# 审查 Agent 代码

先读取用户指定文件，沿着模型响应、参数校验、实际执行和工具结果返回的路径检查。

需要细查时再读取 [检查清单](references/checklist.md)。相对路径基于本文件所在目录。

指出具体问题与对应代码位置，说明能触发问题的输入。没有运行过测试时，不要声称测试通过。
这份说明不授予额外执行权限；写文件和运行命令仍服从 Agent 的执行规则。
