import { ZhiliuExecutionJournal } from "../src/host/zhiliuExecutionJournal.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomBytes, randomUUID, createHash, verify } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZhiliuToolConnection, zhiliuRequestDigest } from "../src/host/zhiliuToolConnection.js";
import type { ZhiliuToolRequest } from "@zcode/shared";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function harness(tool: "file_read" | "file_write" = "file_write") {
  const root = await fs.mkdtemp(join(tmpdir(), "zhiliu-connection-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await fs.mkdir(workspace);
  const pair = generateKeyPairSync("ed25519");
  const row: ZhiliuToolRequest = {
    id: randomUUID(),
    device_id: randomUUID(),
    user_id: randomUUID(),
    space_id: randomUUID(),
    nonce: randomBytes(32).toString("base64url"),
    tool,
    arguments:
      tool === "file_write" ? { path: "hello.md", content: "你好，织流" } : { path: "hello.md" },
    status: "pending",
    expires_at: new Date(Date.now() + 300000).toISOString(),
  };
  const requests: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];
  let failUpload = false;
  const http = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname,
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ path, body });
    expect(init?.redirect).toBe("error");
    if (path.endsWith("/heartbeat")) return Response.json({ online: true });
    if (path.endsWith("/tools")) return Response.json([row]);
    if (path.endsWith("/decision")) {
      expect(
        verify(
          null,
          Buffer.from(`${row.id}\n${row.nonce}\n${body.decision}`),
          pair.publicKey,
          Buffer.from(body.signature, "base64"),
        ),
      ).toBe(true);
      row.status = body.decision;
      return Response.json(row);
    }
    if (path.endsWith("/result")) {
      if (failUpload) throw new Error("offline");
      const digest = createHash("sha256").update(body.output).digest("hex");
      expect(
        verify(
          null,
          Buffer.from(`${row.id}\n${row.nonce}\n${body.status}\n${digest}`),
          pair.publicKey,
          Buffer.from(body.signature, "base64"),
        ),
      ).toBe(true);
      row.status = body.status;
      return Response.json(row);
    }
    return Response.json(row);
  }) as typeof fetch;
  const review = vi.fn(async (kind: string) => (kind === "operation" ? "approve" : "content"));
  const options = {
    origin: "https://zhiliu.example",
    credential: {
      host_token: "dh_test_only_never_real_credential",
      device_id: row.device_id,
      user_id: row.user_id,
      space_id: row.space_id,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    stateDirectory: join(root, "journal"),
    workspacePath: workspace,
    review,
    status: vi.fn(),
    fetch: http,
  };
  const connection = new ZhiliuToolConnection(options);
  cleanup.push(() => connection.stop());
  return {
    root,
    workspace,
    row,
    requests,
    review,
    options,
    connection,
    setFailUpload: (value: boolean) => {
      failUpload = value;
    },
  };
}
describe("织流云文件工具连接", () => {
  it("审批后写文件并签名回传，不启动CLI，重复轮询不再执行", async () => {
    const h = await harness();
    await h.connection.start();
    await vi.waitFor(() => expect(h.row.status).toBe("completed"));
    expect(await fs.readFile(join(h.workspace, "hello.md"), "utf8")).toBe("你好，织流");
    expect(h.review).toHaveBeenCalledTimes(2);
    await h.connection.poll();
    expect(h.review).toHaveBeenCalledTimes(2);
    await h.connection.stop();
    expect(h.requests.at(-1)?.body?.workspace_ready).toBe(false);
  });
  it("拒绝审批不会产生文件或结果上传", async () => {
    const h = await harness();
    h.review.mockResolvedValue("reject");
    await h.connection.start();
    await vi.waitFor(() => expect(h.row.status).toBe("rejected"));
    await expect(fs.stat(join(h.workspace, "hello.md"))).rejects.toHaveProperty("code", "ENOENT");
    expect(h.requests.some((r) => r.path.endsWith("/result"))).toBe(false);
  });
  it("审批期间远端取消，无本机副作用", async () => {
    const h = await harness();
    h.review.mockImplementation(async () => {
      h.row.status = "cancelled";
      return "approve";
    });
    await h.connection.start();
    await vi.waitFor(() => expect(h.review).toHaveBeenCalledOnce());
    await expect(fs.stat(join(h.workspace, "hello.md"))).rejects.toHaveProperty("code", "ENOENT");
    expect(h.requests.some((r) => r.path.endsWith("/decision"))).toBe(false);
  });
  it("读取结果只发摘要时不上传内容", async () => {
    const h = await harness("file_read");
    await fs.writeFile(join(h.workspace, "hello.md"), "PRIVATE-BUSINESS-DATA");
    h.review.mockImplementation(async (kind) => (kind === "operation" ? "approve" : "summary"));
    await h.connection.start();
    await vi.waitFor(() => expect(h.row.status).toBe("completed"));
    const result = h.requests.find((r) => r.path.endsWith("/result"));
    expect(result?.body?.output).toContain("未授权");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-BUSINESS-DATA");
  });
  it("断线只补传已确认的结果，重启不重复执行文件写入", async () => {
    const h = await harness();
    h.setFailUpload(true);
    await h.connection.start();
    await vi.waitFor(() => expect(h.requests.some((r) => r.path.endsWith("/result"))).toBe(true));
    await h.connection.stop();
    await fs.writeFile(join(h.workspace, "hello.md"), "后来的本机编辑");
    h.setFailUpload(false);
    const restarted = new ZhiliuToolConnection(h.options);
    cleanup.push(() => restarted.stop());
    await restarted.start();
    await vi.waitFor(() => expect(h.row.status).toBe("completed"));
    expect(await fs.readFile(join(h.workspace, "hello.md"), "utf8")).toBe("后来的本机编辑");
    expect(h.review).toHaveBeenCalledTimes(2);
    expect(
      await fs.readFile(
        join(h.options.stateDirectory, h.row.device_id, `${h.row.id}.json`),
        "utf8",
      ),
    ).not.toContain("你好");
  });
  it("执行中崩溃的journal恢复只能报不确定，不得再写文件", async () => {
    const h = await harness();
    h.row.status = "approved";
    const secret = createHash("sha256")
      .update(`zhiliu-outbox\n${h.options.origin}\n${h.options.privateKey}`)
      .digest();
    const journal = new ZhiliuExecutionJournal(
      join(h.options.stateDirectory, h.row.device_id),
      secret,
    );
    await journal.open();
    await journal.write(h.row.id, { digest: zhiliuRequestDigest(h.row), stage: "executing" }, true);
    await h.connection.start();
    await vi.waitFor(() => expect(h.row.status).toBe("failed"));
    expect(h.review).not.toHaveBeenCalled();
    await expect(fs.stat(join(h.workspace, "hello.md"))).rejects.toHaveProperty("code", "ENOENT");
  });
  it("跨空间请求拒绝；不会提示原生审批", async () => {
    const h = await harness();
    h.row.space_id = randomUUID();
    await h.connection.start();
    await vi.waitFor(() =>
      expect(h.options.status).toHaveBeenCalledWith(false, expect.any(String)),
    );
    expect(h.review).not.toHaveBeenCalled();
  });
  it("非法敏感路径自动拒绝并终结，不反复弹窗", async () => {
    const h = await harness();
    h.row.arguments.path = ".env";
    await h.connection.start();
    await vi.waitFor(() => expect(h.row.status).toBe("rejected"));
    expect(h.review).not.toHaveBeenCalled();
    await h.connection.poll();
    expect(h.requests.filter((r) => r.path.endsWith("/decision"))).toHaveLength(1);
  });
  it("上传已成功但ACK丢失，重连按单项状态清理outbox", async () => {
    const h = await harness();
    h.setFailUpload(true);
    await h.connection.start();
    await vi.waitFor(() => expect(h.requests.some((r) => r.path.endsWith("/result"))).toBe(true));
    await h.connection.stop();
    h.row.status = "completed";
    h.setFailUpload(false);
    const restarted = new ZhiliuToolConnection(h.options);
    cleanup.push(() => restarted.stop());
    await restarted.start();
    await vi.waitFor(async () => {
      const secret = createHash("sha256")
        .update(`zhiliu-outbox\n${h.options.origin}\n${h.options.privateKey}`)
        .digest();
      const journal = new ZhiliuExecutionJournal(
        join(h.options.stateDirectory, h.row.device_id),
        secret,
      );
      expect((await journal.read(h.row.id))?.stage).toBe("done");
    });
    expect(h.requests.filter((r) => r.path.endsWith("/result"))).toHaveLength(1);
  });
  it("常见Bearer/Key/PEM在预览和上传前脱敏", async () => {
    const h = await harness("file_read");
    await fs.writeFile(
      join(h.workspace, "hello.md"),
      "Bearer abcdefghijklmnop\nsk-test0123456789abcdef\n-----BEGIN PRIVATE KEY-----\nfixture-key\n-----END PRIVATE KEY-----",
    );
    await h.connection.start();
    await vi.waitFor(() => expect(h.row.status).toBe("completed"));
    const preview = h.review.mock.calls.find((call) => call[0] === "result");
    expect(JSON.stringify(preview)).not.toContain("fixture-key");
    const uploaded = JSON.stringify(h.requests.filter((r) => r.path.endsWith("/result")));
    expect(uploaded).not.toContain("abcdefghijklmnop");
    expect(uploaded).not.toContain("sk-test0123");
  });
});
