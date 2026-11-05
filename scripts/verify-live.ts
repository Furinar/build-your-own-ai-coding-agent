// 显式运行的真实模型烟测：不会进入 pnpm test，不产生用户仓库改动。
// pnpm exec tsx --env-file=.env scripts/verify-live.ts
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Model } from "../examples/23-with-goals.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-course-live-"));
const client = new Anthropic({ timeout: 45_000, maxRetries: 0 });
let requests = 0;
let trace: string[] = [];
const realModel: Model = { create: async (request, options) => {
  requests++;
  const response = await client.messages.create(request, {
    signal: AbortSignal.any([options?.signal ?? new AbortController().signal, AbortSignal.timeout(45_000)]),
  });
  trace.push(...response.content.filter((block) => block.type === "tool_use").map((block) => block.name));
  return response;
} };
const report: { lesson: number; status: string; requests: number; tools: string[]; error?: string }[] = [];
const cases = [
  { number: 14, file: "14-with-hooks.ts", prompt: "必须用 write_file 写入 result.txt，内容精确为 LIVE_OK，再用 read_file 核对。", check: (agent: any, cwd: string) => assert.equal(fs.readFileSync(path.join(cwd, "result.txt"), "utf8"), "LIVE_OK") },
  { number: 15, file: "15-with-todos.ts", prompt: "用 todo_write 创建唯一待办 a，状态 in_progress；用 read_file 读取 input.txt；最后 todo_write 保留 a 并标记 completed。", check: (agent: any) => { assert.equal(agent.todos.items.length, 1); assert.equal(agent.todos.items[0].status, "completed"); } },
  { number: 16, file: "16-with-skills.ts", prompt: "调用 load_skill 加载 code-review，然后 read_file 读取 skills/code-review/references/checklist.md，只总结前三条。", check: () => { assert.ok(trace.includes("load_skill")); assert.ok(trace.includes("read_file")); } },
  { number: 17, file: "17-with-task-board.ts", prompt: "task_create 创建 id=a、标题读取文件、depends_on=[]；task_claim 以 alice 领取；read_file 读取 input.txt；用领取返回的 version 和 owner=alice 调用 task_complete。", check: (agent: any) => assert.equal(agent.board.snapshot()[0].status, "completed") },
  { number: 18, file: "18-with-background.ts", prompt: "background_start 执行 node -e 'console.log(42)'，background_wait 等待，然后用返回的 id 调用 background_status。", check: (agent: any) => { const jobs = [...agent.background.jobs.values()] as any[]; assert.equal(jobs[0]?.status, "completed"); assert.match(jobs[0].output, /42/); assert.ok(trace.includes("background_status")); } },
  { number: 19, file: "19-with-cron.ts", prompt: "cron_create 创建 expression=* * * * * *、command=node -e 'console.log(42)'、count=1 的任务，然后 cron_list 查看。不要把创建说成已经执行。", check: (agent: any) => { assert.equal(agent.cron.list().length, 1); assert.ok(trace.includes("cron_create")); } },
  { number: 20, file: "20-with-teams.ts", prompt: "调用 team_send 向 bob 发消息，内容精确为 TEAM_LIVE_OK。", check: (agent: any) => assert.equal(agent.mailbox.inbox("bob")[0]?.text, "TEAM_LIVE_OK") },
  { number: 21, file: "21-with-mcp.ts", prompt: "必须用 mcp_echo 回显 MCP_LIVE_OK，并用 mcp_add 计算 20 加 22。", check: () => { assert.ok(trace.includes("mcp_echo")); assert.ok(trace.includes("mcp_add")); } },
  { number: 22, file: "22-with-workflows.ts", prompt: '必须调用 workflow_run，plan={"id":"live","steps":[{"id":"write","action":"write","input":{"file_path":"result.txt","content":"WORKFLOW_OK"}},{"id":"check","action":"assert_file","input":{"file_path":"result.txt","content":"WORKFLOW_OK"}}]}。', check: (agent: any, cwd: string) => { assert.equal(fs.readFileSync(path.join(cwd, "result.txt"), "utf8"), "WORKFLOW_OK"); assert.ok(trace.includes("workflow_run")); } },
  { number: 23, file: "23-with-goals.ts", prompt: "必须 write_file 写入 result.txt 内容精确为 GOAL_LIVE_OK，再用 read_file 核对。", check: (agent: any) => { assert.ok(agent.goal.evaluations > 0); assert.ok(trace.includes("read_file")); } },
  { number: 24, file: "24-integrated-agent.ts", prompt: '用 todo_write 创建唯一待办 a；workflow_run 使用 id=final 的两步工作流，write 写 result.txt 内容 FINAL_LIVE_OK，assert_file 验证同内容；read_file 读回；todo_write 保留 a 标记 completed。', check: (agent: any, cwd: string) => { assert.equal(fs.readFileSync(path.join(cwd, "result.txt"), "utf8"), "FINAL_LIVE_OK"); assert.equal(agent.todos.pending().length, 0); assert.ok(agent.goal.evaluations > 0); assert.ok(trace.includes("workflow_run")); } },
];
try {
  for (const item of cases) {
    const cwd = path.join(directory, String(item.number));
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "input.txt"), "LIVE_INPUT");
    if (item.number === 16 || item.number === 24) fs.cpSync(path.join(root, "skills"), path.join(cwd, "skills"), { recursive: true });
    trace = [];
    const before = requests;
    let agent: any;
    let timer: NodeJS.Timeout | undefined;
    try {
      const module = await import(path.join(root, "examples", item.file));
      agent = await module.createAgent({ cwd, model: realModel, evaluator: realModel, maxTurns: 12, log: () => {} });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { void agent.close(); reject(new Error("本章真实验证超过 90 秒")); }, 90_000);
      });
      const result = await Promise.race([agent.agentLoop(item.prompt), timeout]);
      assert.doesNotMatch(result, /\[已达到轮次上限\]|\[目标未完成/);
      item.check(agent, cwd);
      const entry = { lesson: item.number, status: "PASS", requests: requests - before, tools: [...trace] };
      report.push(entry); console.log(JSON.stringify(entry));
    } catch (error) {
      const entry = { lesson: item.number, status: "FAIL", requests: requests - before, tools: [...trace], error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
      report.push(entry); console.log(JSON.stringify(entry)); process.exitCode = 1;
    } finally { if (timer) clearTimeout(timer); await agent?.close(); }
  }
  fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
  fs.writeFileSync(path.join(root, ".runtime", "live-verification.json"), JSON.stringify({
    date: new Date().toISOString(), model: process.env.MODEL, fastModel: process.env.FAST_MODEL,
    requests, report,
  }, null, 2));
  console.log(JSON.stringify({ totalRequests: requests, passed: report.filter((item) => item.status === "PASS").length, total: report.length }));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
