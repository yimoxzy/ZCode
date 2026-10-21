import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createManagedModelBroker } from "../src/zhiliu-runtime/broker.js";
import { exampleRuntimeGrant } from "../src/zhiliu-runtime/contract.example.js";

// 显式运行：先build CLI，再 node --import tsx --test packages/services/test/zhiliuManagedRuntimeCli.integration.node-test.ts
const entry = fileURLToPath(
  new URL("../../../apps/zcode-cli/packages/cli/dist/zcode.cjs", import.meta.url),
);
function chunk(response: ServerResponse, delta: unknown, finish_reason: string | null = null) {
  response.write(
    `data: ${JSON.stringify({ id: "chatcmpl-broker", object: "chat.completion.chunk", created: 1, model: "zhiliu-managed", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
  );
}
async function assertNoCredentialFiles(root: string, secrets: string[]): Promise<void> {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) await assertNoCredentialFiles(path, secrets);
    else if (item.isFile()) {
      const bytes = await readFile(path);
      for (const secret of secrets)
        assert.ok(!bytes.includes(Buffer.from(secret)), "运行时凭据不得落盘");
    }
  }
}
for (const scenario of ["tool-loop", "platform-memory", "cancel"] as const) {
  test(`真实CLI -> Host broker -> SaaS gateway: ${scenario}`, { timeout: 90000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "zhiliu-broker-cli-"));
    const fixture = join(root, "fixture.txt");
    await writeFile(fixture, "broker tool fixture", "utf8");
    const requests: Array<{
      body: {
        model: string;
        stream?: boolean;
        messages: Array<{ role: string; content?: unknown }>;
        tools?: Array<{ function?: { name: string } }>;
      };
      auth?: string;
      id?: string;
    }> = [];
    const toolCalls: Array<{ auth?: string; id?: string; body: unknown }> = [];
    let reached!: () => void, disconnected!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const gateway = createServer(async (request, response) => {
      const bytes: Buffer[] = [];
      for await (const part of request) bytes.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(bytes).toString()) as (typeof requests)[number]["body"];
      if (request.url === "/api/runtime-gateway/mcp") {
        const rpc = body as unknown as {
          id?: string | number;
          method: string;
          params?: { protocolVersion?: string };
        };
        let result: unknown = {};
        if (rpc.method === "initialize")
          result = {
            protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "platform-fixture", version: "1" },
          };
        else if (rpc.method === "tools/list")
          result = {
            tools: [
              {
                name: "search_personal_memory",
                description: "Search the current user's confirmed memory",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
          };
        else if (rpc.method === "tools/call") {
          toolCalls.push({
            auth: request.headers.authorization,
            id: request.headers["idempotency-key"] as string | undefined,
            body,
          });
          result = {
            content: [{ type: "text", text: "confirmed recent project: zhiliu memory fixture" }],
          };
        }
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
        return;
      }
      assert.equal(request.url, "/api/runtime-gateway/v1/chat/completions");
      requests.push({
        body,
        auth: request.headers.authorization,
        id: request.headers["idempotency-key"] as string | undefined,
      });
      reached();
      response.on("close", disconnected);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-zhiliu-model-call-id": "fake-model-call",
      });
      if (scenario === "cancel") {
        chunk(response, { role: "assistant", content: "partial" });
        return;
      }
      if (!body.messages.some((message) => message.role === "tool")) {
        const tool =
          scenario === "platform-memory" ? "mcp__zhiliu_platform__search_personal_memory" : "Read";
        assert.ok(body.tools?.some((item) => item.function?.name === tool));
        chunk(response, {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: scenario === "platform-memory" ? "call_memory" : "call_read",
              type: "function",
              function: {
                name: tool,
                arguments: JSON.stringify(
                  scenario === "platform-memory"
                    ? { query: "recent project" }
                    : { file_path: fixture },
                ),
              },
            },
          ],
        });
        chunk(response, {}, "tool_calls");
      } else {
        chunk(response, { role: "assistant", content: "broker final answer" });
        chunk(response, {}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const address = gateway.address();
    assert.ok(address && typeof address !== "string");
    const grant = {
      ...exampleRuntimeGrant,
      expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
    };
    const owned = { origin: `http://127.0.0.1:${address.port}`, grant };
    let revocations = 0;
    const broker = await createManagedModelBroker({
      initial: owned,
      renew: async () => owned,
      revoke: async () => {
        revocations++;
      },
    });
    const profile = {
      ...broker.profile,
      pluginManifest: { roots: [] },
      toolAllowlist:
        scenario === "platform-memory"
          ? ["mcp__zhiliu_platform__search_personal_memory"]
          : ["Read"],
    };
    const child = spawn(
      process.execPath,
      [
        entry,
        "--managed-profile-stdin",
        "--prompt-stdin",
        "--output-format",
        "stream-json",
        "--mode",
        "yolo",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ZCODE_STORAGE_DIR: join(root, "state"),
          OPENAI_API_KEY: "unmanaged-env-key",
          OPENAI_BASE_URL: "https://outside.invalid/v1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value.toString();
    });
    child.stderr.on("data", (value) => {
      stderr += value.toString();
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60000);
    try {
      child.stdin.end(
        JSON.stringify(profile) +
          "\n" +
          JSON.stringify({ text: "Read the fixture and then finish." }) +
          "\n",
      );
      if (scenario === "cancel") {
        await started;
        await broker.dispose();
        await aborted;
      }
      const code = await exit;
      assert.equal(timedOut, false, "CLI应自行完成或收到中断后退出");
      assert.ok(
        requests.length > 0,
        `CLI没有请求broker; exit=${code}; stderr=${stderr}; stdout=${stdout.slice(-2000)}`,
      );
      for (const request of requests) {
        assert.equal(request.body.model, "zhiliu-managed");
        assert.equal(request.auth, `Bearer ${grant.runtime_grant}`);
        assert.ok(request.id, "模型调用必须有稳定幂等标识");
      }
      const secrets = [
        grant.runtime_grant,
        profile.capabilityToken,
        profile.platformTools!.capabilityToken,
      ];
      for (const secret of secrets) {
        assert.ok(!stdout.includes(secret) && !stderr.includes(secret), "凭据不得进入CLI输出");
        assert.ok(!child.spawnargs.join(" ").includes(secret), "凭据不得进入进程argv");
      }
      await assertNoCredentialFiles(root, secrets);
      if (scenario !== "cancel") {
        assert.equal(code, 0, stderr);
        assert.equal(requests.length, 2);
        assert.ok(
          requests[1]!.body.messages.some(
            (message) =>
              message.role === "tool" &&
              JSON.stringify(message.content).includes(
                scenario === "platform-memory" ? "zhiliu memory fixture" : "broker tool fixture",
              ),
          ),
        );
        assert.ok(stdout.includes("broker final answer"));
        assert.notEqual(requests[0]!.id, requests[1]!.id, "不同逻辑模型调用使用不同幂等标识");
        if (scenario === "platform-memory") {
          assert.equal(toolCalls.length, 1, "read工具通过原生MCP执行一次");
          assert.equal(toolCalls[0]!.auth, `Bearer ${grant.runtime_grant}`);
          assert.equal(toolCalls[0]!.id, "tool:call_memory");
        }
      } else {
        assert.equal(requests.length, 1, "中断调用不得自动重放");
        assert.equal(revocations, 1);
      }
    } finally {
      clearTimeout(timer);
      child.kill();
      await broker.dispose();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
