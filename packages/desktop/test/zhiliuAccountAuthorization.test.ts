import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exampleRuntimeGrant } from "../../services/src/zhiliu-runtime/contract.example.js";
import {
  beginZhiliuAccountAuthorization,
  createZhiliuAccountBootstrap,
  createZhiliuRelayGrant,
  createZhiliuAccountDeviceIdentity,
  createZhiliuRuntimeGrant,
  fetchZhiliuAccountSession,
  revokeZhiliuAccount,
  ZhiliuAccountSecureStore,
  type StoredZhiliuAccount,
} from "../src/main/zhiliuAccountAuthorization.js";

const origin = "https://platform.example.test";
const authorizationId = "26c84121-1d9f-4f46-91a5-20688ee3a011";
const credential = () => ({
  login_token: "dl_test-account-token-for-tests-only",
  device_id: "bc8c4237-5b92-4563-904e-d95cc018cb31",
  user_id: "089e7630-3844-49b7-9034-ddab7a4df2f9",
  space_id: "e60165ca-10d0-4cc8-bde5-7693461ba044",
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  user: {
    id: "089e7630-3844-49b7-9034-ddab7a4df2f9",
    email: "test@example.test",
    nickname: "测试",
    is_admin: false,
  },
  space: {
    id: "e60165ca-10d0-4cc8-bde5-7693461ba044",
    name: "测试空间",
    space_type: "personal",
    role: "owner",
  },
});
const authorization = () => ({
  authorization_id: authorizationId,
  device_code: "test-device-code-only-123456",
  user_code: "TEST-2026",
  expires_at: new Date(Date.now() + 600000).toISOString(),
  verification_path: `/#/desktop-authorize?authorize=${authorizationId}`,
  poll_interval_seconds: 3,
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const record = (): StoredZhiliuAccount => ({
  origin,
  ...createZhiliuAccountDeviceIdentity(),
  credential: credential(),
});

describe("织流浏览器账号授权证明", () => {
  it.each([
    undefined,
    {
      agent_id: authorizationId,
      inference_profile_id: "00000000-0000-4000-8000-000000000005",
    },
  ])("仅 Main 在默认或所选 Agent 授权中固定声明已验证的记忆审批能力：%j", async (selection) => {
    const saved = record(),
      now = Date.now(),
      workspaceIdentity = `local:${"a".repeat(64)}`;
    const grant = {
      ...exampleRuntimeGrant,
      expires_at: new Date(now + 600000).toISOString(),
      profile: { ...exampleRuntimeGrant.profile, platform_tools_write_enabled: false },
    };
    const http = vi.fn<typeof fetch>().mockResolvedValue(response(grant));
    await expect(
      createZhiliuRuntimeGrant(saved, workspaceIdentity, http, () => now, selection),
    ).resolves.toEqual({ origin, grant });
    expect(http.mock.calls[0]![0]).toBe(`${origin}/api/desktop-auth/runtime-grants`);
    expect(http.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: `Bearer ${saved.credential.login_token}` },
    });
    expect(JSON.parse(http.mock.calls[0]![1]!.body as string)).toEqual({
      workspace_identity: workspaceIdentity,
      ...selection,
      platform_memory_write_capability: "forced_approval_and_execution_identity_v1",
    });
  });
  it("拒绝从 Agent 选择注入或覆盖记忆能力声明，且不发出授权请求", async () => {
    const http = vi.fn<typeof fetch>();
    const selection = {
      agent_id: null,
      inference_profile_id: null,
      platform_memory_write_capability: "forged_version",
    };
    await expect(
      createZhiliuRuntimeGrant(record(), `local:${"a".repeat(64)}`, http, Date.now, selection),
    ).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });
  it("relay只在Main以dl_换同user+space+native设备的短期rc_，拒绝身份或期限越界", async () => {
    const saved = record(),
      now = Date.now();
    const grant = {
      protocol_version: 1,
      relay_grant: "rc_example_non_secret_01234567890123456789",
      principal_id: `${saved.credential.user_id}:${saved.credential.space_id}`,
      desktop_device_id: saved.credential.device_id,
      expires_at: new Date(now + 300000).toISOString(),
    };
    const http = vi.fn<typeof fetch>().mockResolvedValue(response(grant));
    expect(
      await createZhiliuRelayGrant(saved, saved.credential.device_id, http, () => now),
    ).toEqual(grant);
    expect(http.mock.calls[0]![0]).toBe(`${origin}/api/desktop-auth/relay-grants`);
    expect(http.mock.calls[0]![1]).toMatchObject({
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: `Bearer ${saved.credential.login_token}` },
      body: JSON.stringify({ device_mid: saved.credential.device_id }),
    });
    await expect(createZhiliuRelayGrant(saved, "wrong-device", http, () => now)).rejects.toThrow(
      "电脑身份不匹配",
    );
    expect(http).toHaveBeenCalledTimes(1);
    for (const invalid of [
      { ...grant, principal_id: saved.credential.user_id },
      { ...grant, desktop_device_id: authorizationId },
      { ...grant, expires_at: new Date(now + 360001).toISOString() },
    ]) {
      http.mockResolvedValueOnce(response(invalid));
      await expect(
        createZhiliuRelayGrant(saved, saved.credential.device_id, http, () => now),
      ).rejects.toThrow("远控授权身份或有效期无效");
    }
  });
  it("opens only the fixed platform route and proves possession of a fresh PKCE and Ed25519 key", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(authorization()))
      .mockResolvedValueOnce(response(credential()));
    const pending = await beginZhiliuAccountAuthorization(origin, http);
    expect(pending.verificationUrl).toBe(
      `${origin}/#/desktop-authorize?authorize=${authorizationId}`,
    );
    expect(pending.verificationUrl).not.toContain(authorization().device_code);
    const first = JSON.parse(http.mock.calls[0]![1]!.body as string);
    expect(http.mock.calls[0]![1]).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(first).not.toHaveProperty("private_key");
    expect(first).not.toHaveProperty("code_verifier");
    const saved = await pending.exchange();
    const exchange = JSON.parse(http.mock.calls[1]![1]!.body as string);
    expect(createHash("sha256").update(exchange.code_verifier).digest("base64url")).toBe(
      first.code_challenge,
    );
    const payload = `zhiliu-login-exchange\n${authorizationId}\n${authorization().device_code}\n${exchange.code_verifier}`;
    expect(
      verify(
        null,
        Buffer.from(payload),
        createPublicKey(first.public_key),
        Buffer.from(exchange.signature, "base64"),
      ),
    ).toBe(true);
    expect(saved?.publicKey).toBe(first.public_key);
    expect(saved?.privateKey).toContain("PRIVATE KEY");
  });
  it.each(["authorization_pending", { code: "authorization_pending" }])(
    "accepts only an explicit pending marker: %j",
    async (detail) => {
      const http = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(authorization()))
        .mockResolvedValueOnce(response({ detail }, 409))
        .mockResolvedValueOnce(response(credential()));
      const pending = await beginZhiliuAccountAuthorization(origin, http);
      await expect(pending.exchange()).resolves.toBeNull();
      await expect(pending.exchange()).resolves.toMatchObject({ origin });
    },
  );
  it.each([
    { verification_path: "https://evil.example.test/authorize" },
    { verification_path: "/#/desktop-authorize?authorize=wrong" },
    { expires_at: "not-a-date" },
    { poll_interval_seconds: 0 },
    { expires_at: new Date(Date.now() + 7200000).toISOString() },
  ])("rejects malformed/untrusted authorization metadata: %j", async (change) => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...authorization(), ...change }));
    await expect(beginZhiliuAccountAuthorization(origin, http)).rejects.toThrow();
  });
  it("rejects an upstream secret in place of a narrowly scoped desktop grant", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(authorization()))
      .mockResolvedValueOnce(response({ ...credential(), login_token: "sk_test" }));
    await expect(
      (await beginZhiliuAccountAuthorization(origin, http)).exchange(),
    ).rejects.toThrow();
  });
  it("validates current identity and never sends a native token to a business endpoint", async () => {
    const saved = record();
    const { login_token: _ignored, ...session } = saved.credential;
    const http = vi.fn<typeof fetch>().mockResolvedValue(response(session));
    await expect(fetchZhiliuAccountSession(saved, http)).resolves.toEqual(session);
    expect(http.mock.calls[0]![0]).toBe(`${origin}/api/desktop-auth/session`);
    expect(http.mock.calls[0]![1]!.headers).toEqual({
      Authorization: `Bearer ${saved.credential.login_token}`,
    });
    http.mockResolvedValueOnce(response({ ...session, space_id: authorizationId }));
    await expect(fetchZhiliuAccountSession(saved, http)).rejects.toThrow("身份不匹配");
  });
  it("accepts a bounded bootstrap ticket and uses a separate revocation endpoint", async () => {
    const saved = record(),
      ticket = "bootstrap-test-ticket-only-123456";
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ ticket, expires_at: new Date(Date.now() + 60000).toISOString() }),
      )
      .mockResolvedValueOnce(response(null));
    await expect(createZhiliuAccountBootstrap(saved, http)).resolves.toBe(ticket);
    await expect(revokeZhiliuAccount(saved, http)).resolves.toBeUndefined();
    expect(http.mock.calls.map((call) => call[0])).toEqual([
      `${origin}/api/desktop-auth/bootstrap`,
      `${origin}/api/desktop-auth/logout`,
    ]);
  });
  it("rejects expired/overlong bootstrap tickets and unexpected grant failures", async () => {
    const saved = record();
    const http = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        ticket: "bootstrap-test-ticket-only-123456",
        expires_at: new Date(Date.now() + 120000).toISOString(),
      }),
    );
    await expect(createZhiliuAccountBootstrap(saved, http)).rejects.toThrow();
    http.mockResolvedValueOnce(response({ detail: "authorization_expired" }, 410));
    await expect(revokeZhiliuAccount(saved, http)).resolves.toBeUndefined();
    http.mockResolvedValueOnce(response({ detail: "unavailable" }, 500));
    await expect(revokeZhiliuAccount(saved, http)).rejects.toThrow();
  });
});

describe("织流 Main 账号安全存储", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (!directory) return;
    const relative = path.relative(await fs.realpath(tmpdir()), directory);
    if (
      !path.isAbsolute(directory) ||
      !relative.startsWith("zhiliu-account-auth-") ||
      relative.includes(path.sep)
    )
      throw new Error("Unexpected credential-test cleanup target");
    await fs.rm(directory, { recursive: true, force: true });
    directory = undefined;
  });
  async function fixture() {
    directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "zhiliu-account-auth-")));
    const key = randomBytes(32);
    const safe = {
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => "test_secure"),
      encryptString: vi.fn((value: string) => {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      }),
      decryptString: vi.fn((sealed: Buffer) => {
        const cipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
        cipher.setAuthTag(sealed.subarray(12, 28));
        return Buffer.concat([cipher.update(sealed.subarray(28)), cipher.final()]).toString("utf8");
      }),
    };
    return {
      safe,
      store: new ZhiliuAccountSecureStore(directory, safe),
      file: path.join(directory, `${createHash("sha256").update(origin).digest("hex")}.sealed`),
    };
  }
  it("persists only encrypted native grants and device keys, then removes them", async () => {
    const { store, file } = await fixture(),
      saved = record();
    await store.write(saved);
    const content = (await fs.readFile(file)).toString("utf8");
    expect(content).not.toContain(saved.privateKey);
    expect(content).not.toContain(saved.credential.login_token);
    await expect(store.read(origin)).resolves.toEqual(saved);
    await store.remove(origin);
    await expect(store.read(origin)).resolves.toBeNull();
  });
  it("rejects plaintext storage, invalid key pairs, and hard-linked credentials", async () => {
    const { safe, store, file } = await fixture();
    safe.getSelectedStorageBackend.mockReturnValue("basic_text");
    await expect(store.write(record())).rejects.toThrow("安全存储不可用");
    safe.getSelectedStorageBackend.mockReturnValue("test_secure");
    const saved = record();
    await expect(
      store.write({ ...saved, publicKey: createZhiliuAccountDeviceIdentity().publicKey }),
    ).rejects.toThrow("密钥无效");
    await store.write(saved);
    await fs.link(file, path.join(directory!, "alias.sealed"));
    await expect(store.read(origin)).rejects.toThrow("凭据文件无效");
  });
});
