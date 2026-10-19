import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  beginZhiliuHostAuthorization,
  ZhiliuHostStore,
  type StoredZhiliuHost,
} from "../src/main/zhiliuHostAuthorization.js";

const origin = "https://platform.example.test";
const authorizationId = "26c84121-1d9f-4f46-91a5-20688ee3a011";
const authorization = {
  authorization_id: authorizationId,
  device_code: "device-code-for-test-only",
  user_code: "PAIR-2026",
  expires_at: new Date(Date.now() + 300000).toISOString(),
};
const credential = () => ({
  host_token: "host-token-for-test-only-123456",
  device_id: "bc8c4237-5b92-4563-904e-d95cc018cb31",
  user_id: "089e7630-3844-49b7-9034-ddab7a4df2f9",
  space_id: "e60165ca-10d0-4cc8-bde5-7693461ba044",
  expires_at: new Date(Date.now() + 3600000).toISOString(),
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function secureStorage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => "test_secure_backend"),
    encryptString: vi.fn((text: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    }),
    decryptString: vi.fn((sealed: Buffer) => {
      const cipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
      cipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([cipher.update(sealed.subarray(28)), cipher.final()]).toString("utf8");
    }),
  };
}

describe("织流设备配对密钥证明", () => {
  it("uses an independent PKCE verifier and verifies the Ed25519 exchange signature", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(authorization))
      .mockResolvedValueOnce(response(credential()));
    const pending = await beginZhiliuHostAuthorization(origin, http);
    const first = http.mock.calls[0]!;
    const initial = JSON.parse(first[1]!.body as string);
    expect(first[0]).toBe(`${origin}/api/desktop-host/authorizations`);
    expect(first[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
    });
    expect(initial).toMatchObject({
      platform: process.platform,
      name: expect.stringContaining("织流电脑"),
      public_key: expect.stringContaining("BEGIN PUBLIC KEY"),
      code_challenge: expect.stringMatching(/^[\w-]{43}$/u),
    });
    expect(initial).not.toHaveProperty("private_key");
    expect(initial).not.toHaveProperty("code_verifier");
    expect(first[1]!.signal).toBeInstanceOf(AbortSignal);
    expect(pending).toMatchObject({
      authorizationId,
      userCode: authorization.user_code,
      expiresAt: authorization.expires_at,
    });
    const record = await pending.exchange();
    const second = http.mock.calls[1]!;
    const exchange = JSON.parse(second[1]!.body as string);
    expect(second[0]).toBe(`${origin}/api/desktop-host/exchange`);
    expect(second[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(createHash("sha256").update(exchange.code_verifier).digest("base64url")).toBe(
      initial.code_challenge,
    );
    const payload = `zhiliu-host-exchange\n${authorizationId}\n${authorization.device_code}\n${exchange.code_verifier}`;
    expect(
      verify(
        null,
        Buffer.from(payload),
        createPublicKey(initial.public_key),
        Buffer.from(exchange.signature, "base64"),
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(payload + "tampered"),
        createPublicKey(initial.public_key),
        Buffer.from(exchange.signature, "base64"),
      ),
    ).toBe(false);
    expect(record?.origin).toBe(origin);
    expect(record?.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(
      createPublicKey(record!.privateKey).export({ type: "spki", format: "pem" }).toString(),
    ).toBe(initial.public_key);
  });

  it.each(["authorization_pending", { code: "authorization_pending" }])(
    "returns pending only for the explicit 409 marker: %j",
    async (detail) => {
      const http = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(authorization))
        .mockResolvedValueOnce(response({ detail }, 409))
        .mockResolvedValueOnce(response(credential()));
      const pending = await beginZhiliuHostAuthorization(origin, http);
      await expect(pending.exchange()).resolves.toBeNull();
      await expect(pending.exchange()).resolves.toMatchObject({ origin });
      expect(JSON.parse(http.mock.calls[1]![1]!.body as string).code_verifier).toBe(
        JSON.parse(http.mock.calls[2]![1]!.body as string).code_verifier,
      );
    },
  );

  it.each([400, 401, 403, 409, 410, 500])(
    "rejects failed or expired exchange responses (%s)",
    async (status) => {
      const http = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(authorization))
        .mockResolvedValueOnce(response({ detail: "authorization_expired" }, status));
      await expect((await beginZhiliuHostAuthorization(origin, http)).exchange()).rejects.toThrow(
        "设备授权已失效",
      );
    },
  );

  it("rejects invalid credential payloads instead of accepting an upstream API key", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(authorization))
      .mockResolvedValueOnce(response({ ...credential(), api_key: "must-not-be-accepted" }));
    await expect((await beginZhiliuHostAuthorization(origin, http)).exchange()).rejects.toThrow();
  });

  it.each([
    { ...authorization, authorization_id: "not-an-id" },
    { ...authorization, user_code: "bad code!" },
    { ...authorization, device_code: null },
    { ...authorization, expires_at: "not-a-date" },
    { ...authorization, expires_at: new Date(Date.now() - 60000).toISOString() },
  ])("rejects malformed authorization responses", async (row) => {
    await expect(
      beginZhiliuHostAuthorization(origin, vi.fn<typeof fetch>().mockResolvedValue(response(row))),
    ).rejects.toThrow("设备授权响应不正确");
  });

  it("uses a fresh key pair and PKCE challenge for each pairing", async () => {
    const http = vi.fn<typeof fetch>().mockImplementation(async () => response(authorization));
    await beginZhiliuHostAuthorization(origin, http);
    await beginZhiliuHostAuthorization(origin, http);
    const first = JSON.parse(http.mock.calls[0]![1]!.body as string);
    const second = JSON.parse(http.mock.calls[1]![1]!.body as string);
    expect(first.public_key).not.toBe(second.public_key);
    expect(first.code_challenge).not.toBe(second.code_challenge);
  });
});

describe("织流 Host 凭据安全存储", () => {
  let directory: string;
  let safe: ReturnType<typeof secureStorage>;
  let store: ZhiliuHostStore;
  const record = (): StoredZhiliuHost => ({
    origin,
    privateKey: "private-host-key-for-test-only",
    credential: credential(),
  });
  const sealedPath = (url: string) =>
    path.join(directory, `${createHash("sha256").update(url).digest("hex")}.sealed`);

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "zhiliu-host-auth-")));
    safe = secureStorage();
    store = new ZhiliuHostStore(directory, safe);
  });
  afterEach(async () => {
    const relative = path.relative(await fs.realpath(tmpdir()), directory);
    if (
      !path.isAbsolute(directory) ||
      !relative.startsWith("zhiliu-host-auth-") ||
      relative.includes(path.sep)
    )
      throw new Error("Unexpected credential-test cleanup target");
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("encrypts private material, round-trips the bound origin and removes it on disconnect", async () => {
    const value = record();
    await store.write(value);
    expect(safe.encryptString).toHaveBeenCalledWith(JSON.stringify(value));
    const sealed = await fs.readFile(sealedPath(origin));
    expect(sealed.toString("utf8")).not.toContain(value.privateKey);
    expect(sealed.toString("utf8")).not.toContain(value.credential.host_token);
    expect(await fs.readdir(directory)).toEqual([path.basename(sealedPath(origin))]);
    await expect(store.read(origin)).resolves.toEqual(value);
    await expect(store.read("https://other.example.test")).resolves.toBeNull();
    await store.remove(origin);
    await expect(store.read(origin)).resolves.toBeNull();
  });

  it("rejects encrypted credentials copied under a different origin", async () => {
    await store.write(record());
    const other = "https://other.example.test";
    await fs.copyFile(sealedPath(origin), sealedPath(other));
    await expect(store.read(other)).rejects.toThrow("设备凭据来源不匹配");
  });

  it("treats an expired host credential as unavailable", async () => {
    const value = record();
    value.credential.expires_at = new Date(Date.now() - 60000).toISOString();
    await store.write(value);
    await expect(store.read(origin)).resolves.toBeNull();
  });

  it.each(["encryption_unavailable", "basic_text"])(
    "fails closed when secure storage is unavailable (%s)",
    async (mode) => {
      if (mode === "encryption_unavailable") safe.isEncryptionAvailable.mockReturnValue(false);
      else safe.getSelectedStorageBackend.mockReturnValue("basic_text");
      await expect(store.read(origin)).rejects.toThrow("系统安全存储不可用");
      await expect(store.write(record())).rejects.toThrow("系统安全存储不可用");
      expect(safe.encryptString).not.toHaveBeenCalled();
      expect(safe.decryptString).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );

  it("rejects corrupt, oversized and hard-linked credential files", async () => {
    await fs.writeFile(sealedPath(origin), Buffer.alloc(16001));
    await expect(store.read(origin)).rejects.toThrow("设备凭据文件无效");
    expect(safe.decryptString).not.toHaveBeenCalled();
    await store.write(record());
    const sealed = await fs.readFile(sealedPath(origin));
    sealed[sealed.length - 1] ^= 0xff;
    await fs.writeFile(sealedPath(origin), sealed);
    await expect(store.read(origin)).rejects.toThrow();
    await store.write(record());
    await fs.link(sealedPath(origin), path.join(directory, "alias.sealed"));
    await expect(store.read(origin)).rejects.toThrow("设备凭据文件无效");
  });

  it("cleans up staging files when safe-storage encryption fails", async () => {
    safe.encryptString.mockImplementationOnce(() => {
      throw new Error("secure backend failed");
    });
    await expect(store.write(record())).rejects.toThrow("secure backend failed");
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
