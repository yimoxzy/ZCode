import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/zcode.cjs", import.meta.url));
const capability = "local_capability_test_123456789012345678901";
const toolCapability = "independent_tool_capability_12345678901234567890";

async function assertNoCredentialsOnDisk(root: string): Promise<void> {
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await assertNoCredentialsOnDisk(path);
    else if (entry.isFile()) {
      const data = await readFile(path);
      assert.ok(!data.includes(capability) && !data.includes(toolCapability), "runtime capabilities must not be persisted");
    }
  }
}

function chunk(res: ServerResponse, delta: unknown, finish_reason: string | null = null) {
  res.write(`data: ${JSON.stringify({id: "chatcmpl-managed", object: "chat.completion.chunk", created: 1,
    model: "zhiliu-managed", choices: [{index: 0, delta, finish_reason}]})}\n\n`);
}

for (const scenario of ["tool-loop", "platform-tool", "platform-failure", "platform-approval-denied", "no-tools", "responses", "rejected", "partial-failure"] as const) {
  test(`managed CLI process: ${scenario}`, {timeout: 90000}, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zhiliu-managed-cli-"));
    const fixture = join(root, "example.txt");
    await writeFile(fixture, "managed fixture contents", "utf8");
    const requests: {body: any; headers: any}[] = [];
    const toolRequests: any[] = [];
    const server = createServer(async (req, res) => {
      if (req.url === "/mcp" && req.method !== "POST") {res.writeHead(req.method === "DELETE" ? 204 : 405); res.end(); return;}
      const bytes: Buffer[] = []; for await (const part of req) bytes.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(bytes).toString());
      if (req.url === "/mcp") {
        assert.equal(req.headers.authorization, `Bearer ${toolCapability}`);
        if (!Object.hasOwn(body, "id")) {res.writeHead(202); res.end(); return;}
        let result: unknown;
        if (body.method === "initialize") result = {protocolVersion: body.params.protocolVersion,
          capabilities: {tools: {}}, serverInfo: {name: "zhiliu-platform", version: "1.0.0"}};
        else if (body.method === "tools/list") result = {tools: [{name: "clarify", description: "Ask for confirmed context",
          inputSchema: {type: "object", properties: {question: {type: "string"}}, required: ["question"]}, annotations: {readOnlyHint: true}}]};
        else if (body.method === "tools/call") {
          toolRequests.push(body);
          assert.equal(body.params._meta.tool_call_id, "call_platform_1");
          for (const key of ["session_id", "turn_id"]) {
            assert.equal(typeof body.params._meta[key], "string");
            assert.ok(body.params._meta[key].length > 0 && body.params._meta[key].length <= 200,
              `native MCP must carry bounded stable ${key}`);
          }
          assert.equal(req.headers["idempotency-key"], "tool:call_platform_1");
          await new Promise<void>(resolve => setTimeout(resolve, 50));
          assert.equal(requests.length, 1, "Loop must wait for actual MCP result before another model request");
          if (scenario === "platform-failure") {res.destroy(); return;}
          result = {content: [{type: "text", text: "confirmed enterprise context"}]};
        } else result = {};
        res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify({jsonrpc: "2.0", id: body.id, result})); return;
      }
      requests.push({body, headers: req.headers});
      if (scenario === "responses") {
        assert.equal(body.store, false);
        res.writeHead(200, {"content-type": "text/event-stream"});
        const item = {id: "msg_managed", type: "message", role: "assistant", status: "completed",
          content: [{type: "output_text", text: "managed final answer", annotations: []}]};
        const response = {id: "resp_managed", object: "response", created_at: 1, model: "zhiliu-managed", status: "completed", output: [item],
          usage: {input_tokens: 5, output_tokens: 3, total_tokens: 8}};
        const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        emit({type: "response.created", response: {...response, status: "in_progress", output: []}});
        emit({type: "response.output_item.added", output_index: 0, item: {...item, status: "in_progress", content: []}});
        emit({type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: {type: "output_text", text: "", annotations: []}});
        emit({type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "managed final answer"});
        emit({type: "response.output_item.done", output_index: 0, item});
        emit({type: "response.completed", response}); res.end(); return;
      }
      if (scenario === "rejected") {res.writeHead(503, {"content-type": "application/json"}); res.end('{"error":{"message":"unavailable","type":"server_error"}}'); return;}
      if (!body.stream) {
        res.writeHead(200, {"content-type": "application/json"});
        res.end(JSON.stringify({id: "chatcmpl-managed", object: "chat.completion", created: 1, model: "zhiliu-managed",
          choices: [{index: 0, message: {role: "assistant", content: "managed final answer"}, finish_reason: "stop"}], usage: {prompt_tokens: 5, completion_tokens: 3, total_tokens: 8}})); return;
      }
      res.writeHead(200, {"content-type": "text/event-stream"});
      if (scenario === "partial-failure") {
        chunk(res, {role: "assistant", content: "partial text"});
        res.end('data: {"error":{"message":"Provider stream failed with ECONNRESET","type":"server_error"}}\n\n'); return;
      }
      const hasToolResult = body.messages.some((message: any) => message.role === "tool");
      if (scenario.startsWith("platform-") && !hasToolResult) {
        assert.deepEqual(body.tools.map((tool: any) => tool.function?.name), ["mcp__zhiliu_platform__clarify"]);
        chunk(res, {role: "assistant", tool_calls: [{index: 0, id: "call_platform_1", type: "function",
          function: {name: "mcp__zhiliu_platform__clarify", arguments: '{"question":"Company context?"}'}}]});
        chunk(res, {}, "tool_calls");
      } else if (scenario === "tool-loop" && !hasToolResult) {
        assert.ok(body.tools.some((tool: any) => tool.function?.name === "Read"));
        chunk(res, {role: "assistant", tool_calls: [{index: 0, id: "call_read_1", type: "function",
          function: {name: "Read", arguments: JSON.stringify({file_path: fixture})}}]});
        chunk(res, {}, "tool_calls");
      } else {chunk(res, {role: "assistant", content: "managed final answer"}); chunk(res, {}, "stop");}
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const profile = {version: 1, gatewayBaseUrl: `http://127.0.0.1:${address.port}/v1`, capabilityToken: capability,
      modelId: "zhiliu-managed", protocol: scenario === "responses" ? "responses" : "chat_completions", maxContextTokens: 128000, maxOutputTokens: 4096,
      instructions: "You are a managed assistant.", pluginManifest: {roots: []}, toolAllowlist: scenario === "tool-loop" ? ["Read"] : scenario.startsWith("platform-") ? ["mcp__zhiliu_platform__clarify"] : [],
      ...(scenario.startsWith("platform-") ? {platformTools: {url: `http://127.0.0.1:${address.port}/mcp`, capabilityToken: toolCapability, timeoutMs: 5000}} : {})};
    if (scenario === "platform-approval-denied") Object.assign(profile, {approvalRequiredTools: ["mcp__zhiliu_platform__clarify"]});
    const child = spawn(process.execPath, [entry, "--managed-profile-stdin", "--prompt-stdin", "--output-format", "stream-json", "--mode", scenario.startsWith("platform-") && scenario !== "platform-approval-denied" ? "build" : "yolo"], {
      cwd: root, env: {...process.env, ZCODE_STORAGE_DIR: join(root, "state"),
        OPENAI_API_KEY: "host-key-must-not-be-used", OPENAI_BASE_URL: "https://outside.invalid/v1"}, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => {stdout += data.toString();}); child.stderr.on("data", data => {stderr += data.toString();});
    const timer = setTimeout(() => child.kill(), 60000);
    try {
      child.stdin.end(JSON.stringify(profile) + "\n" + JSON.stringify({text: "Read the sample if a tool is available, then finish."}) + "\n");
      const code = await new Promise<number | null>((resolve, reject) => {child.once("exit", resolve); child.once("error", reject);});
      assert.ok(![stdout, stderr].some(output => output.includes(capability) || output.includes(toolCapability)), "capability must not appear in process output");
      assert.ok(requests.length > 0, `no model request; exit=${code} stderr=${stderr} stdout=${stdout.slice(-2000)}`);
      t.diagnostic(`SDK request keys: ${Object.keys(requests[0].body).sort().join(", ")}`);
      for (const request of requests) {
        assert.equal(request.body.model, "zhiliu-managed"); assert.equal(request.headers.authorization, `Bearer ${capability}`);
        assert.ok(request.headers["idempotency-key"]);
      }
      if (scenario === "tool-loop") {
        assert.equal(code, 0, stderr); assert.equal(requests.length, 2);
        assert.ok(requests[1].body.messages.some((m: any) => m.role === "tool" && JSON.stringify(m).includes("managed fixture contents")));
        assert.ok(stdout.includes("managed final answer"));
      } else if (scenario.startsWith("platform-")) {
        assert.equal(code, 0, stderr); assert.equal(requests.length, 2);
        assert.equal(toolRequests.length, scenario === "platform-approval-denied" ? 0 : 1, "approval must prevent execution; unknown execution must not be replayed");
        if (scenario === "platform-approval-denied") assert.ok(requests[1].body.messages.some((m: any) => m.role === "tool" && JSON.stringify(m).includes("No permission client configured")));
        const toolEvents = stdout.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
          .filter(event => event.type === "tool.updated");
        assert.ok(toolEvents.length > 0, "platform tool lifecycle must be projected to typed NDJSON");
        for (const event of toolEvents) {
          if (["scheduled", "started"].includes(event.payload.kind))
            assert.equal(event.payload.toolName, "mcp__zhiliu_platform__clarify");
          if (event.payload.kind === "batch") assert.deepEqual(event.payload.toolCallIds, ["call_platform_1"]);
          else assert.equal(event.payload.toolCallId, "call_platform_1");
        }
        t.diagnostic(`Platform tool NDJSON envelope: ${JSON.stringify(toolEvents.map(event => ({
          type: event.type, payload: {kind: event.payload.kind, toolName: event.payload.toolName, toolCallId: event.payload.toolCallId}
        })))}`);
        if (scenario === "platform-tool") assert.ok(requests[1].body.messages.some((m: any) => m.role === "tool" && JSON.stringify(m).includes("confirmed enterprise context")));
        assert.ok(stdout.includes("managed final answer"));
      } else if (scenario === "no-tools" || scenario === "responses") {
        assert.equal(code, 0, stderr); assert.ok(!requests[0].body.tools?.length); assert.ok(stdout.includes("managed final answer"));
      } else {assert.equal(requests.length, 1, "failed physical request must not replay automatically");}
      await assertNoCredentialsOnDisk(root);
    } finally {
      clearTimeout(timer); child.kill(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, {recursive: true, force: true});
    }
  });
}
