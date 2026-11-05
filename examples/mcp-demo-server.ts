// stdio 的 stdout 只用于 MCP 协议；不要向它 console.log。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "course-demo", version: "1.0.0" });
server.tool("echo", "回显一段文本。", { text: z.string() },
  async ({ text }) => ({ content: [{ type: "text", text }] }));
server.tool("add", "计算两个数之和。", { a: z.number(), b: z.number() },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
await server.connect(new StdioServerTransport());
