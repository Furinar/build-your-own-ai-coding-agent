import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import ts from "typescript";
import vm from "node:vm";
import { createAgent as hooks } from "../examples/14-with-hooks.ts";
import { TodoList, createAgent as todoAgent } from "../examples/15-with-todos.ts";
import { SkillLibrary } from "../examples/16-with-skills.ts";
import { TaskBoard } from "../examples/17-with-task-board.ts";
import { BackgroundJobs, createAgent as backgroundAgent } from "../examples/18-with-background.ts";
import { CronJobs } from "../examples/19-with-cron.ts";
import { TeamMailbox, Worktrees } from "../examples/20-with-teams.ts";
import { McpConnection } from "../examples/21-with-mcp.ts";
import { WorkflowRunner, fileActions } from "../examples/22-with-workflows.ts";
import { GoalMonitor, createAgent as goalAgent, type Model } from "../examples/23-with-goals.ts";
import { createAgent as integrated } from "../examples/24-integrated-agent.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function temporary(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-course-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function text(value: string): Pick<Anthropic.Message, "content"> {
  return { content: [{ type: "text", text: value, citations: null }] };
}
function use(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
}
function sequence(responses: Pick<Anthropic.Message, "content">[]) {
  const requests: Parameters<Model["create"]>[0][] = [];
  const model: Model = { create: async (request) => {
    requests.push(structuredClone(request));
    const response = responses.shift();
    assert.ok(response, "模型调用超过预期");
    return response;
  } };
  return { model, requests };
}
const silent = { log: () => {} };

test("Hook 拒绝写入仍配对回传，Stop 可继续一轮", async (t) => {
  const cwd = temporary(t);
  const scripted = sequence([{ content: [use("deny", "write_file", { file_path: ".env-demo", content: "bad" })] }, text("结束"), text("已核对")]);
  const agent = hooks({ cwd, ...scripted, ...silent });
  t.after(() => agent.close());
  let stopCount = 0;
  agent.on("Stop", () => stopCount++ === 0 ? "再核对一次" : undefined);
  assert.equal(await agent.agentLoop("写文件"), "已核对");
  assert.equal(fs.existsSync(path.join(cwd, ".env-demo")), false);
  const result = scripted.requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
  assert.equal(result[0].tool_use_id, "deny");
  assert.equal(result[0].is_error, true);
});

test("待办输入失败不破坏原状态，也不能删除项目绕过完成", () => {
  const todos = new TodoList();
  todos.replace([{ id: "a", content: "读取", status: "pending" }]);
  assert.throws(() => todos.replace([
    { id: "a", content: "读取", status: "in_progress" },
    { id: "b", content: "写入", status: "in_progress" },
  ]), /同时只能/);
  assert.equal(todos.items[0].status, "pending");
  assert.throws(() => todos.replace([]), /不能删除/);
  todos.replace([{ id: "a", content: "读取", status: "completed" }]);
  assert.throws(() => todos.replace([{ id: "a", content: "读取", status: "pending" }]), /不能倒退/);
});

test("未完成待办使纯文本回复接回循环，完成后停止", async (t) => {
  const scripted = sequence([
    { content: [use("todo", "todo_write", { items: [{ id: "a", content: "核对", status: "pending" }] })] },
    text("完成了"),
    { content: [use("finish", "todo_write", { items: [{ id: "a", content: "核对", status: "completed" }] })] },
    text("真实收尾"),
  ]);
  const agent = await todoAgent({ cwd: temporary(t), ...scripted, ...silent });
  t.after(() => agent.close());
  assert.equal(await agent.agentLoop("任务"), "真实收尾");
  assert.equal(scripted.requests.length, 4);
  assert.match(scripted.requests[2].messages.at(-1)!.content as string, /未完成待办/);
});

test("Skills 支持多行 YAML，目录不泄露全文，未知名称拒绝", (t) => {
  const directory = temporary(t);
  fs.mkdirSync(path.join(directory, "review"));
  fs.writeFileSync(path.join(directory, "review", "SKILL.md"), "---\nname: review\ndescription: |\n  第一行\n  第二行\n---\nPRIVATE_BODY");
  const library = new SkillLibrary(directory);
  assert.match(library.catalog()[0].description, /第二行/);
  assert.doesNotMatch(JSON.stringify(library.catalog()), /PRIVATE_BODY/);
  assert.match(library.load("review"), /PRIVATE_BODY/);
  assert.throws(() => library.load("../other"), /未知/);
  fs.mkdirSync(path.join(directory, "bad"));
  fs.writeFileSync(path.join(directory, "bad", "SKILL.md"), "---\nname: [\n---\n");
  assert.throws(() => new SkillLibrary(directory), /YAML/);
});

test("DAG 阻塞依赖，恢复状态，并拒绝他人或旧版本更新", (t) => {
  const directory = temporary(t);
  const board = new TaskBoard(directory);
  board.add("a", "读取"); board.add("b", "写入", ["a"]);
  assert.throws(() => board.add("cycle", "坏依赖", ["cycle"]), /依赖必须/);
  assert.throws(() => board.claim("b", "bob"), /依赖尚未/);
  const claim = board.claim("a", "alice");
  assert.throws(() => board.complete("a", "bob", claim.version), /不匹配/);
  assert.throws(() => board.complete("a", "alice", claim.version - 1), /不匹配/);
  board.complete("a", "alice", claim.version);
  assert.equal(new TaskBoard(directory).claim("b", "bob").owner, "bob");
});

test("独立进程竞争领取同一个任务，最多一个成功", async (t) => {
  const directory = temporary(t);
  new TaskBoard(directory).add("same", "争抢");
  const source = path.join(root, "examples/17-with-task-board.ts");
  const run = (owner: string) => new Promise<number>((resolve, reject) => {
    const script = `import { TaskBoard } from ${JSON.stringify(source)}; try { new TaskBoard(${JSON.stringify(directory)}).claim("same", ${JSON.stringify(owner)}); process.exit(0); } catch { process.exit(2); }`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: root, stdio: "ignore" });
    child.once("error", reject); child.once("close", (code) => resolve(code ?? 99));
  });
  const codes = await Promise.all([run("alice"), run("bob")]);
  assert.deepEqual(codes.sort(), [0, 2]);
});

test("后台进程输出与失败退出码真实可读，通知只消费一次", async (t) => {
  const jobs = new BackgroundJobs(temporary(t));
  t.after(() => jobs.close());
  const success = jobs.start("node -e 'console.log(42)'");
  const failure = jobs.start("node -e 'console.error(\"failed\");process.exit(7)'");
  await jobs.waitAll();
  assert.equal(jobs.get(success).status, "completed");
  assert.match(jobs.get(success).output, /42/);
  assert.equal(jobs.get(failure).exitCode, 7);
  assert.equal(jobs.get(failure).status, "failed");
  assert.equal(jobs.drain().length, 2);
  assert.equal(jobs.drain().length, 0);
});

test("取消后台进程组并等待关闭，缓冲限制生效", async (t) => {
  const jobs = new BackgroundJobs(temporary(t));
  t.after(() => jobs.close());
  const large = jobs.start("node -e 'console.log(\"x\".repeat(20000))'");
  await jobs.waitAll();
  assert.equal(jobs.get(large).output.length, 12_000);
  const long = jobs.start("node -e 'setInterval(()=>{},1000)'");
  await jobs.cancel(long);
  assert.equal(jobs.get(long).status, "cancelled");
  assert.notEqual(jobs.get(long).exitCode, undefined);
});

test("后台完成通知进入模型请求，结束前可等待", async (t) => {
  const scripted = sequence([{ content: [use("start", "background_start", { command: "node -e 'console.log(42)'" }), use("wait", "background_wait", {})] }, text("结束")]);
  const agent = await backgroundAgent({ cwd: temporary(t), ...scripted, ...silent });
  t.after(() => agent.close());
  assert.equal(await agent.agentLoop("运行"), "结束");
  assert.match(scripted.requests[1].messages.at(-1)!.content as string, /后台通知/);
});

test("cron 失败不确认，恢复成功才扣次数，幂等 key 不变", async (t) => {
  const directory = temporary(t);
  const cron = new CronJobs(directory);
  const job = cron.create("*/1 * * * * *", "demo", 1, 0);
  const keys: string[] = [];
  await cron.tick(job.nextDue, async (_, key) => { keys.push(key); throw new Error("失败"); });
  assert.equal(cron.list()[0].remaining, 1);
  assert.equal(cron.list()[0].nextDue, job.nextDue);
  const restored = new CronJobs(directory);
  await restored.tick(job.nextDue, async (_, key) => { keys.push(key); });
  assert.equal(restored.list()[0].remaining, 0);
  assert.equal(keys[0], keys[1]);
});

test("cron 同时 tick 不重复执行，关闭后不再自动唤醒", async (t) => {
  const cron = new CronJobs(temporary(t));
  const job = cron.create("* * * * * *", "demo", 1, 0);
  let calls = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const execute = async () => { calls++; await waiting; };
  const first = cron.tick(job.nextDue, execute);
  const second = cron.tick(job.nextDue, execute);
  assert.equal(first, second);
  release(); await first;
  assert.equal(calls, 1);
  cron.start(async () => { calls++; });
  await cron.close();
  assert.equal(cron.list()[0].remaining, 0);
});

test("邮箱读取不确认，重启恢复，批准严格绑定版本和他人", (t) => {
  const directory = temporary(t);
  const board = new TaskBoard(path.join(directory, "tasks"));
  const mail = new TeamMailbox(directory);
  board.add("a", "审查");
  const task = board.claim("a", "alice");
  const request = mail.send("alice", "bob", "请审查", "request", "a", task.version);
  assert.equal(new TeamMailbox(directory).inbox("bob").length, 1);
  mail.send("bob", "alice", "通过", "approval", "a", task.version);
  assert.equal(mail.approved(task, "bob"), true);
  assert.equal(mail.approved({ ...task, version: task.version + 1 }, "bob"), false);
  assert.equal(mail.approved(task, "alice"), false);
  assert.throws(() => mail.acknowledge("alice", request.id), /没有/);
  mail.acknowledge("bob", request.id);
  assert.equal(new TeamMailbox(directory).inbox("bob").length, 0);
});

test("真实 Git worktree 使用成员目录执行 status，不污染根目录", (t) => {
  const directory = temporary(t);
  execFileSync("git", ["init", "-q", directory]);
  fs.writeFileSync(path.join(directory, "tracked.txt"), "original");
  execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
  // 只在临时测试仓库创建 fixture 提交，不修改用户仓库或 Git 配置。
  execFileSync("git", ["-c", "user.name=Course Test", "-c", "user.email=course-test@example.invalid", "commit", "-qm", "test fixture"], { cwd: directory });
  const worktrees = new Worktrees(directory);
  const worktree = worktrees.create("alice");
  fs.writeFileSync(path.join(worktree, "only-member.txt"), "isolated");
  assert.match(worktrees.run("alice", ["status"]), /only-member/);
  assert.equal(fs.existsSync(path.join(directory, "only-member.txt")), false);
  assert.throws(() => worktrees.create("../escape"), /成员名/);
  assert.throws(() => worktrees.run("alice", ["reset"]), /仅支持/);
  fs.unlinkSync(path.join(worktree, "only-member.txt"));
  execFileSync("git", ["worktree", "remove", worktree], { cwd: directory });
});

test("官方 MCP stdio 握手、发现、调用、参数错误与关闭", async () => {
  const connection = new McpConnection(path.join(root, "examples/mcp-demo-server.ts"));
  try {
    const tools = await connection.connect();
    assert.deepEqual(tools.map((entry) => entry.definition.name).sort(), ["mcp_add", "mcp_echo"]);
    const add = tools.find((entry) => entry.definition.name === "mcp_add")!;
    assert.equal(await add.call({ a: 20, b: 22 }), "42");
    assert.match(await add.call({ a: "bad", b: 22 }), /^Error:/);
  } finally { await connection.close(); }
});

test("工作流失败后恢复未完成步骤，缓存必须核实实际文件", async (t) => {
  const cwd = temporary(t);
  let checks = 0;
  const actions = fileActions(cwd);
  actions.once = { schema: z.object({}), run: () => { if (checks++ === 0) throw new Error("暂时失败"); return "OK"; }, verify: (_, output) => output === "OK" };
  const plan = { id: "resume", steps: [
    { id: "write", action: "write", input: { file_path: "result.txt", content: "OK" } },
    { id: "check", action: "once", input: {} },
  ] };
  const directory = path.join(cwd, "runs");
  await assert.rejects(new WorkflowRunner(directory, actions).run(plan), /暂时失败/);
  const resumed = await new WorkflowRunner(directory, actions).run(plan);
  assert.equal(resumed.attempts, 3);
  assert.equal(checks, 2);
  assert.ok(resumed.events.some((entry) => entry.step === "write" && entry.type === "cached"));
  fs.writeFileSync(path.join(cwd, "result.txt"), "external");
  await assert.rejects(new WorkflowRunner(directory, actions).run(plan), /证据过期/);
});

test("无效工作流完整预检不产生副作用，计划 id 绑定哈希", async (t) => {
  const cwd = temporary(t);
  const runner = new WorkflowRunner(path.join(cwd, "runs"), fileActions(cwd));
  const write = { id: "write", action: "write", input: { file_path: "result.txt", content: "OK" } };
  await assert.rejects(runner.run({ id: "invalid", steps: [write, { id: "bad", action: "unknown", input: {} }] }), /未注册/);
  assert.equal(fs.existsSync(path.join(cwd, "result.txt")), false);
  await assert.rejects(runner.run({ id: "schema", steps: [write, { id: "bad", action: "read", input: { file_path: 1 } }] }));
  assert.equal(fs.existsSync(path.join(cwd, "result.txt")), false);
  await runner.run({ id: "immutable", steps: [write] });
  await assert.rejects(runner.run({ id: "immutable", steps: [{ ...write, input: { file_path: "result.txt", content: "OTHER" } }] }), /不可更换/);
});

test("失败执行跨恢复消耗预算，取消不执行副作用", async (t) => {
  const cwd = temporary(t);
  let calls = 0;
  const runner = new WorkflowRunner(path.join(cwd, "runs"), {
    fail: { schema: z.object({}), run: () => { calls++; throw new Error("failed"); }, verify: () => false },
  });
  const plan = { id: "budget", steps: [{ id: "fail", action: "fail", input: {} }] };
  await assert.rejects(runner.run(plan, { maxCalls: 1 }), /failed/);
  await assert.rejects(runner.run(plan, { maxCalls: 1 }), /预算/);
  assert.equal(calls, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runner.run({ ...plan, id: "cancelled" }, { signal: abort.signal }));
  assert.equal(calls, 1);
});

test("验收拒绝假 id、无证据完成和无效 JSON，失败工具不计证据", async () => {
  const fake: Model = { create: async () => text(JSON.stringify({ status: "completed", reason: "通过", evidence_ids: ["fabricated"] })) };
  const monitor = new GoalMonitor("完成", fake);
  monitor.record("read_file", {}, "Error: 缺失");
  assert.equal(monitor.evidence.length, 0);
  await assert.rejects(monitor.evaluate(new AbortController().signal), /不存在/);
  const noEvidence = new GoalMonitor("完成", { create: async () => text('{"status":"completed","reason":"通过","evidence_ids":[]}') });
  await assert.rejects(noEvidence.evaluate(new AbortController().signal), /完成必须/);
  const invalid = new GoalMonitor("完成", { create: async () => text("not JSON") });
  await assert.rejects(invalid.evaluate(new AbortController().signal), SyntaxError);
  const premature = new GoalMonitor("命令成功", { create: async (request) => {
    const data = JSON.parse(request.messages[0].content as string);
    return text(JSON.stringify({ status: "completed", reason: "通过", evidence_ids: data.evidence.map((entry: { id: string }) => entry.id) }));
  } });
  premature.record("background_status", {}, '{"status":"running"}');
  await assert.rejects(premature.evaluate(new AbortController().signal), /成功检查/);
});

test("独立验收不含 assistant 自述，可继续补证并受次数限制", async (t) => {
  const execution = sequence([
    text("完成了"),
    { content: [use("read", "read_file", { file_path: "result.txt" })] },
    text("核对完成"),
  ]);
  const cwd = temporary(t); fs.writeFileSync(path.join(cwd, "result.txt"), "OK");
  const evaluator: Model = { create: async (request) => {
    assert.equal(request.tools.length, 0);
    assert.equal(request.messages.length, 1);
    assert.doesNotMatch(JSON.stringify(request.messages), /完成了/);
    const data = JSON.parse(request.messages[0].content as string);
    return text(JSON.stringify({ status: data.evidence.length ? "completed" : "continue", reason: "需要核对", evidence_ids: data.evidence.map((entry: { id: string }) => entry.id) }));
  } };
  const agent = await goalAgent({ cwd, ...execution, evaluator, ...silent });
  t.after(() => agent.close());
  assert.equal(await agent.agentLoop("result.txt 必须为 OK"), "核对完成");
  assert.equal(agent.goal!.evaluations, 2);
  const limited = new GoalMonitor("完成", evaluator, 0);
  await assert.rejects(limited.evaluate(new AbortController().signal), /次数耗尽/);
});

test("综合循环联通工作流、待办、真实读取与隔离验收", async (t) => {
  const cwd = temporary(t);
  const plan = { id: "integrated", steps: [
    { id: "write", action: "write", input: { file_path: "final.txt", content: "FINAL_OK" } },
    { id: "assert", action: "assert_file", input: { file_path: "final.txt", content: "FINAL_OK" } },
  ] };
  const execution = sequence([
    { content: [use("todo", "todo_write", { items: [{ id: "a", content: "写入核对", status: "in_progress" }] })] },
    { content: [use("workflow", "workflow_run", { plan })] },
    { content: [use("read", "read_file", { file_path: "final.txt" })] },
    { content: [use("done", "todo_write", { items: [{ id: "a", content: "写入核对", status: "completed" }] })] },
    text("完成"),
  ]);
  const evaluator: Model = { create: async (request) => {
    const data = JSON.parse(request.messages[0].content as string);
    const evidence = data.evidence.find((entry: { tool: string; output: string }) => entry.tool === "read_file" && entry.output === "FINAL_OK");
    assert.ok(evidence);
    return text(JSON.stringify({ status: "completed", reason: "实际读回一致", evidence_ids: [evidence.id] }));
  } };
  const agent = await integrated({ cwd, ...execution, evaluator, ...silent });
  try {
    assert.equal(await agent.agentLoop("写入 FINAL_OK 并核对"), "完成");
    assert.equal(fs.readFileSync(path.join(cwd, "final.txt"), "utf8"), "FINAL_OK");
    assert.equal(agent.todos.pending().length, 0);
    assert.equal(agent.goal!.evaluations, 1);
  } finally { await agent.close(); }
});

test("03～12 章的真实 replace 表达式保留美元占位符字面量", () => {
  for (const name of fs.readdirSync(path.join(root, "examples")).filter((name) => /^(0[3-9]|1[0-2])-/.test(name))) {
    const source = fs.readFileSync(path.join(root, "examples", name), "utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    let found = 0;
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "replace" && node.arguments[0] && ts.isIdentifier(node.arguments[0])
        && ts.isIdentifier(node.expression.expression)) {
        found++;
        const expression = ts.transpile(node.getText(ast), { target: ts.ScriptTarget.ES2022 });
        const result = vm.runInNewContext(expression, {
          content: "before ORIGINAL after", c: "before ORIGINAL after",
          actualString: "ORIGINAL", actual: "ORIGINAL", a: "ORIGINAL",
          newString: "$& $1 $$ $` $'", new_string: "$& $1 $$ $` $'", ns: "$& $1 $$ $` $'",
        });
        assert.equal(result, "before $& $1 $$ $` $' after", name);
      }
      ts.forEachChild(node, walk);
    };
    walk(ast); assert.equal(found, 1, name);
  }
});

test("11 章真实搜索 handler 拒绝普通文本，接受服务端结果", async () => {
  const source = fs.readFileSync(path.join(root, "examples/11-with-web-access.ts"), "utf8");
  const ast = ts.createSourceFile("web.ts", source, ts.ScriptTarget.Latest, true);
  let handler: ts.MethodDeclaration | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some((item) => ts.isPropertyAssignment(item)
      && item.name.getText(ast) === "name" && item.initializer.getText(ast) === '"web_search"')) {
      const candidate = node.properties.find((item): item is ts.MethodDeclaration => ts.isMethodDeclaration(item) && item.name.getText(ast) === "call");
      if (candidate) handler = candidate;
    }
    ts.forEachChild(node, walk);
  };
  walk(ast); assert.ok(handler);
  const expression = ts.transpile(`({ ${handler.getText(ast)} }).call`, { target: ts.ScriptTarget.ES2022 });
  const call = (content: unknown[]) => vm.runInNewContext(expression, {
    FAST_MODEL: "test", client: { messages: { create: async () => ({ content }) } },
  })({ query: "test" }) as Promise<string>;
  assert.match(await call([{ type: "text", text: "搜索完成了" }]), /^Error:/);
  assert.equal(await call([{ type: "web_search_tool_result", content: [{ title: "官网", url: "https://example.com" }] }]), "- 官网: https://example.com");
  assert.match(await call([{ type: "web_search_tool_result", content: { error_code: "unavailable" } }]), /^Error:/);
});

test("课程导航链接存在，进阶示例包含完整循环且无内部运行时依赖", () => {
  const files = [path.join(root, "README.md"), ...fs.readdirSync(path.join(root, "chapters")).map((name) => path.join(root, "chapters", name))];
  for (const file of files) {
    const markdown = fs.readFileSync(file, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), `${file}: ${target}`);
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (let number = 14; number <= 24; number++) {
    const file = pkg.scripts[`example:${number}`].split(" ").at(-1);
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /async function agentLoop/);
    assert.match(source, /tool_use_id: block.id/);
    assert.doesNotMatch(source, /from ["']\.\.?\/(shared|runtime|1[4-9]|2[0-4])/);
    assert.match(source, /--prompt/);
  }
});
