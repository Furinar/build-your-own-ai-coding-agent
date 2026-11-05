# 第 21 章：通过 MCP 发现外部工具

本章完整示例：[21-with-mcp.ts](../examples/21-with-mcp.ts)。请先读前一章，再沿着本文件中的 `createAgent → execute → agentLoop` 路径阅读。

## MCP 改变工具来源，循环仍然相同

前面的工具全写在本文件。MCP 把工具发现和远程调用标准化，模型依然看到名称、描述和 JSON Schema，依然返回 tool_use。McpConnection.connect 将 listTools 结果转换成 Tool，插入原工具数组；agentLoop 无需区分本地和外部来源。

## 这里连接的是真服务

examples/mcp-demo-server.ts 使用官方 @modelcontextprotocol/sdk 创建 stdio 服务，提供 echo 和 add。本章使用 Client 与 StdioClientTransport 启动它，完成协议握手、listTools 和 callTool。--demo 不调用模型，但执行真实 MCP 协议；不是返回预写工具结果的替代接口。

## 参数在哪一侧验证

先沿这三个官方 SDK 调用阅读：

```typescript
await this.client.connect(this.transport);
const result = await this.client.listTools();
const response = await this.client.callTool(
  { name: entry.name, arguments: input },
  undefined,
  { timeout: 10_000 },
);
```

`connect` 是握手，`listTools` 是发现，`callTool` 才产生执行结果。发现到 `add` 不代表已经计算过任何数值。

远端返回的 JSON Schema 原样提供给模型，本地只检查参数是对象，真正的细粒度参数校验由 MCP 服务负责。对任意第三方 Schema，要在客户端完整验证应加入兼容的 JSON Schema validator；不能用 z.record 假装已覆盖服务器的字段规则。演示服务使用 Zod 检查数值参数。

## 错误、输出类型和名称冲突

工具名添加 mcp_ 前缀，防止覆盖本地 read_file。isError 会转换为本循环识别的 Error:，最终对应 tool_result.is_error。文本内容直接返回，其他内容用 JSON 展示；生产客户端可为图片等内容保留原协议类型。本例每次调用限时 10 秒。

## 退出必须关闭 transport

main 的 finally 调用 agent.close，进一步关闭 MCP Client，避免 stdio 服务子进程残留。连接或发现失败也会关闭客户端。服务不能向 stdout 打印调试日志，否则会污染协议流；应写 stderr。不要直接执行来源不明的服务配置。

## 亲手验证

先运行 --demo，应发现 mcp_echo、mcp_add 并得到 42。再运行真实模型任务，终端应该看到两次 mcp_ 调用。测试覆盖握手、真实调用、参数错误以及关闭；不需要外部网站或任何 MCP 账号。

## 运行入口

在仓库根目录完成依赖安装并配置 `.env` 后运行：

```bash
pnpm run example:21 -- --help
pnpm run example:21 -- --prompt "用 mcp_echo 回显 MCP_READY，再用 mcp_add 计算 20 加 22。"
```

不传 `--prompt` 则进入交互终端，输入 `q` 或 `exit` 退出。工具具有实际读写能力；建议复制示例到练习目录，或为导出的 `createAgent` 传入临时 `cwd`。

机制演示不需要 API key，可直接运行：

```bash
pnpm exec tsx examples/21-with-mcp.ts --demo
```

项目的 `pnpm run example:21` 脚本仍读取 `.env`，因此没有环境文件时请使用上面的直接入口。

## 阅读检查点

- 在 `tools` 数组中找出本章新增的工具及其模型 Schema。
- 在 `execute` 中找出参数校验、实际执行和错误转成 `tool_result` 的路径。
- 在 `agentLoop` 中确认模型响应先写入历史，每个 `tool_use_id` 都有对应结果。
- 区分内存状态与磁盘状态，说明退出后哪些内容仍会保留。
- 故意制造一次失败，核对终端、工具结果与真实状态是否一致。

[上一章](20-teams.md) · [下一章：工作流、事件与恢复](22-workflows.md)
