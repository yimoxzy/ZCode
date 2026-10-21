import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runtimeGrantSchema } from "@zcode/services/zhiliu-runtime";
import {
  zhiliuRuntimeCatalogSchema,
  zhiliuRuntimeSelectionSchema,
  type ZhiliuRuntimeSelection,
} from "@zcode/shared";

const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().max(320),
  nickname: z.string().max(200).nullable().optional(),
  is_admin: z.boolean(),
});
const spaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(200),
  tenant_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  space_type: z.string().max(30),
  role: z.string().max(30),
});
export const zhiliuAccountSessionSchema = z.object({
  device_id: z.string().uuid(),
  user_id: z.string().uuid(),
  space_id: z.string().uuid(),
  expires_at: z.string().datetime({ offset: true }),
  user: userSchema,
  space: spaceSchema,
});
export const zhiliuAccountCredentialSchema = zhiliuAccountSessionSchema
  .extend({
    login_token: z.string().regex(/^dl_[\w-]{20,509}$/u),
  })
  .strict();
export type ZhiliuAccountSession = z.infer<typeof zhiliuAccountSessionSchema>;
export type ZhiliuAccountCredential = z.infer<typeof zhiliuAccountCredentialSchema>;
export interface ZhiliuAccountDeviceIdentity {
  privateKey: string;
  publicKey: string;
}
export interface StoredZhiliuAccount extends ZhiliuAccountDeviceIdentity {
  origin: string;
  credential: ZhiliuAccountCredential;
}
export interface ZhiliuAccountStore {
  read(origin: string): Promise<StoredZhiliuAccount | null>;
  write(value: StoredZhiliuAccount): Promise<void>;
  remove(origin: string): Promise<void>;
}
interface SecureStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

function checkIdentity(value: ZhiliuAccountDeviceIdentity) {
  const privateKey = createPrivateKey(value.privateKey);
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() !==
      value.publicKey
  )
    throw new Error("桌面设备密钥无效");
}

/** 仅 Main 使用；云窗和 UI 不读取这个存储。调用者拥有唯一串行读写队列。 */
export class ZhiliuAccountSecureStore implements ZhiliuAccountStore {
  constructor(
    private directory: string,
    private safe: SecureStorage,
  ) {}
  private check() {
    if (
      !this.safe.isEncryptionAvailable() ||
      this.safe.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error("系统安全存储不可用，无法登录织流");
  }
  private path(origin: string) {
    return join(this.directory, `${createHash("sha256").update(origin).digest("hex")}.sealed`);
  }
  async read(origin: string): Promise<StoredZhiliuAccount | null> {
    this.check();
    let file;
    try {
      file = await fs.open(this.path(origin), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16000)
        throw new Error("桌面账号凭据文件无效");
      const value = z
        .object({
          origin: z.string().url(),
          privateKey: z.string().max(2048),
          publicKey: z.string().max(2048),
          credential: zhiliuAccountCredentialSchema,
        })
        .strict()
        .parse(JSON.parse(this.safe.decryptString(await file.readFile())));
      if (value.origin !== origin) throw new Error("桌面账号凭据来源不匹配");
      checkIdentity(value);
      return value;
    } finally {
      await file.close();
    }
  }
  async write(value: StoredZhiliuAccount) {
    this.check();
    checkIdentity(value);
    zhiliuAccountCredentialSchema.parse(value.credential);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("桌面账号凭据目录无效");
    const target = this.path(value.origin),
      temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(this.safe.encryptString(JSON.stringify(value)));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async remove(origin: string) {
    await fs.rm(this.path(origin), { force: true });
  }
}

export class ZhiliuAccountHttpError extends Error {
  constructor(readonly status: number) {
    super("织流账号授权无效或服务暂时不可用");
  }
}

/** 登录凭据只由Main消费，Host收到的仅是限权短期模型grant。 */
export async function createZhiliuRuntimeGrant(
  record: StoredZhiliuAccount,
  workspaceIdentity: string,
  http: typeof fetch = fetch,
  now: () => number = Date.now,
  selection?: ZhiliuRuntimeSelection,
) {
  if (!/^local:[a-f0-9]{64}$/u.test(workspaceIdentity)) throw new Error("工作区身份无效");
  const response = await http(`${record.origin}/api/desktop-auth/runtime-grants`, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${record.credential.login_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspace_identity: workspaceIdentity,
      ...(selection ? zhiliuRuntimeSelectionSchema.parse(selection) : {}),
      // 仅新版托管 CLI 已验证强制审批与稳定 session/turn 身份；旧客户端缺省必须只读。
      // 兼容声明固定在 Main，不从 Renderer、选择或环境配置接受用户覆盖。
      platform_memory_write_capability: "forced_approval_and_execution_identity_v1",
    }),
  });
  if (!response.ok) throw new ZhiliuAccountHttpError(response.status);
  const grant = runtimeGrantSchema.parse(await response.json());
  if (
    Date.parse(grant.expires_at) <= now() ||
    Date.parse(grant.expires_at) > now() + 960000 ||
    Date.parse(grant.expires_at) > Date.parse(record.credential.expires_at)
  )
    throw new Error("模型授权有效期无效");
  return { origin: record.origin, grant };
}

/** Native root credential never crosses the Main boundary; returned catalog has strict safe fields. */
export async function fetchZhiliuRuntimeCatalog(
  record: StoredZhiliuAccount,
  http: typeof fetch = fetch,
) {
  const response = await http(`${record.origin}/api/desktop-auth/runtime-catalog`, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${record.credential.login_token}` },
  });
  if (!response.ok) throw new ZhiliuAccountHttpError(response.status);
  return zhiliuRuntimeCatalogSchema.parse(await response.json());
}

export async function revokeZhiliuRuntimeGrant(
  record: StoredZhiliuAccount,
  grantId: string,
  http: typeof fetch = fetch,
) {
  z.string().uuid().parse(grantId);
  const response = await http(`${record.origin}/api/desktop-auth/runtime-grants/${grantId}`, {
    method: "DELETE",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${record.credential.login_token}` },
  });
  if (!response.ok && response.status !== 401 && response.status !== 404)
    throw new ZhiliuAccountHttpError(response.status);
}
export async function createZhiliuRelayGrant(
  record: StoredZhiliuAccount,
  deviceMid: string,
  http: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  if (deviceMid !== record.credential.device_id) throw new Error("电脑身份不匹配");
  const response = await http(`${record.origin}/api/desktop-auth/relay-grants`, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
    headers: {
      Authorization: `Bearer ${record.credential.login_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ device_mid: deviceMid }),
  });
  if (!response.ok) throw new ZhiliuAccountHttpError(response.status);
  const value = z
    .object({
      protocol_version: z.literal(1),
      relay_grant: z.string().regex(/^rc_[A-Za-z0-9_-]{20,512}$/u),
      expires_at: z.string().datetime({ offset: true }),
      principal_id: z.string().min(1).max(200),
      desktop_device_id: z.string().uuid(),
    })
    .strict()
    .parse(await response.json());
  if (
    value.principal_id !== `${record.credential.user_id}:${record.credential.space_id}` ||
    value.desktop_device_id !== deviceMid ||
    Date.parse(value.expires_at) <= now() ||
    Date.parse(value.expires_at) > now() + 360000 ||
    Date.parse(value.expires_at) > Date.parse(record.credential.expires_at)
  )
    throw new Error("远控授权身份或有效期无效");
  return value;
}
export function createZhiliuAccountDeviceIdentity(): ZhiliuAccountDeviceIdentity {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export async function beginZhiliuAccountAuthorization(
  origin: string,
  http: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const identity = createZhiliuAccountDeviceIdentity();
  const verifier = randomBytes(32).toString("base64url");
  const result = await http(`${origin}/api/desktop-auth/authorizations`, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({
      name: `织流客户端 · ${process.platform}`,
      platform: process.platform,
      public_key: identity.publicKey,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }),
  });
  if (!result.ok) throw new ZhiliuAccountHttpError(result.status);
  const pending = z
    .object({
      authorization_id: z.string().uuid(),
      device_code: z.string().regex(/^[\w-]{16,512}$/u),
      user_code: z.string().regex(/^[\w-]{4,24}$/u),
      expires_at: z.string().datetime({ offset: true }),
      poll_interval_seconds: z.number().int().min(1).max(30),
      verification_path: z.string(),
    })
    .parse(await result.json());
  const path = `/#/desktop-authorize?authorize=${pending.authorization_id}`;
  if (
    Date.parse(pending.expires_at) <= now() ||
    Date.parse(pending.expires_at) > now() + 660000 ||
    pending.verification_path !== path
  )
    throw new Error("桌面授权响应不正确");
  return {
    authorizationId: pending.authorization_id,
    userCode: pending.user_code,
    expiresAt: pending.expires_at,
    pollIntervalMs: pending.poll_interval_seconds * 1000,
    verificationUrl: new URL(path, origin).href,
    exchange: async (): Promise<StoredZhiliuAccount | null> => {
      const payload = `zhiliu-login-exchange\n${pending.authorization_id}\n${pending.device_code}\n${verifier}`;
      const response = await http(`${origin}/api/desktop-auth/exchange`, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(12000),
        body: JSON.stringify({
          authorization_id: pending.authorization_id,
          device_code: pending.device_code,
          code_verifier: verifier,
          signature: sign(null, Buffer.from(payload), identity.privateKey).toString("base64"),
        }),
      });
      if (response.status === 409) {
        const error = z
          .object({
            detail: z.union([
              z.literal("authorization_pending"),
              z.object({ code: z.literal("authorization_pending") }),
            ]),
          })
          .safeParse(await response.json());
        if (error.success) return null;
      }
      if (!response.ok) throw new ZhiliuAccountHttpError(response.status);
      const credential = zhiliuAccountCredentialSchema.parse(await response.json());
      checkAccountSession(credential, credential, now());
      return { origin, ...identity, credential };
    },
  };
}

function checkAccountSession(
  session: ZhiliuAccountSession,
  credential: ZhiliuAccountCredential,
  now: number,
) {
  if (
    session.device_id !== credential.device_id ||
    session.user_id !== credential.user_id ||
    session.space_id !== credential.space_id ||
    session.user.id !== credential.user_id ||
    session.space.id !== credential.space_id ||
    Date.parse(session.expires_at) <= now
  )
    throw new Error("桌面账号身份不匹配或已过期");
}
export async function fetchZhiliuAccountSession(
  record: StoredZhiliuAccount,
  http: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ZhiliuAccountSession> {
  const result = await http(`${record.origin}/api/desktop-auth/session`, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${record.credential.login_token}` },
  });
  if (!result.ok) throw new ZhiliuAccountHttpError(result.status);
  const session = zhiliuAccountSessionSchema.parse(await result.json());
  checkAccountSession(session, record.credential, now());
  return session;
}
export async function createZhiliuAccountBootstrap(
  record: StoredZhiliuAccount,
  http: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const result = await http(`${record.origin}/api/desktop-auth/bootstrap`, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${record.credential.login_token}` },
  });
  if (!result.ok) throw new ZhiliuAccountHttpError(result.status);
  const value = z
    .object({
      ticket: z.string().regex(/^[\w-]{20,512}$/u),
      expires_at: z.string().datetime({ offset: true }),
    })
    .strict()
    .parse(await result.json());
  if (Date.parse(value.expires_at) <= now() || Date.parse(value.expires_at) > now() + 65000)
    throw new Error("云工作台授权已过期");
  return value.ticket;
}
export async function revokeZhiliuAccount(record: StoredZhiliuAccount, http: typeof fetch = fetch) {
  const result = await http(`${record.origin}/api/desktop-auth/logout`, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${record.credential.login_token}` },
  });
  if (!result.ok && ![401, 404, 410].includes(result.status))
    throw new ZhiliuAccountHttpError(result.status);
}
