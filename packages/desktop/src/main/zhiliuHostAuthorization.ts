import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { zhiliuHostCredentialSchema, type ZhiliuHostCredential } from "@zcode/shared";

export type StoredZhiliuHost = {
  origin: string;
  privateKey: string;
  credential: ZhiliuHostCredential;
};
interface SecureStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(value: Buffer): string;
}
/** 不读取个人 provider 文件，不保存或导出平台上游 Key。 */
export class ZhiliuHostStore {
  constructor(
    private directory: string,
    private safe: SecureStorage,
  ) {}
  private check() {
    if (
      !this.safe.isEncryptionAvailable() ||
      this.safe.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error("系统安全存储不可用，电脑连接已关闭");
  }
  private path(origin: string) {
    return join(this.directory, `${createHash("sha256").update(origin).digest("hex")}.sealed`);
  }
  async read(origin: string): Promise<StoredZhiliuHost | null> {
    this.check();
    let file;
    try {
      file = await fs.open(this.path(origin), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16000)
        throw new Error("设备凭据文件无效");
      const value = JSON.parse(this.safe.decryptString(await file.readFile()));
      const credential = zhiliuHostCredentialSchema.parse(value.credential);
      if (value.origin !== origin || typeof value.privateKey !== "string")
        throw new Error("设备凭据来源不匹配");
      if (Date.parse(credential.expires_at) <= Date.now()) return null;
      return { origin, privateKey: value.privateKey, credential };
    } finally {
      await file.close();
    }
  }
  async write(value: StoredZhiliuHost) {
    this.check();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("设备凭据目录无效");
    const path = this.path(value.origin),
      temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    const file = await fs.open(temp, "wx", 0o600);
    try {
      try {
        await file.writeFile(this.safe.encryptString(JSON.stringify(value)));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temp, path);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async remove(origin: string) {
    await fs.rm(this.path(origin), { force: true });
  }
}

export async function beginZhiliuHostAuthorization(origin: string, http: typeof fetch = fetch) {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const verifier = randomBytes(32).toString("base64url");
  const response = await http(`${origin}/api/desktop-host/authorizations`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({
      name: `织流电脑 · ${process.platform}`,
      platform: process.platform,
      public_key: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }),
  });
  if (!response.ok) throw new Error("创建设备授权失败");
  const row = await response.json();
  if (
    !/^[a-f0-9-]{36}$/iu.test(row.authorization_id) ||
    typeof row.device_code !== "string" ||
    !/^[\w-]{4,24}$/u.test(row.user_code) ||
    !Number.isFinite(Date.parse(row.expires_at)) ||
    Date.parse(row.expires_at) <= Date.now()
  )
    throw new Error("设备授权响应不正确");
  return {
    authorizationId: row.authorization_id as string,
    userCode: row.user_code as string,
    expiresAt: row.expires_at as string,
    exchange: async (): Promise<StoredZhiliuHost | null> => {
      const payload = `zhiliu-host-exchange\n${row.authorization_id}\n${row.device_code}\n${verifier}`;
      const result = await http(`${origin}/api/desktop-host/exchange`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(12000),
        body: JSON.stringify({
          authorization_id: row.authorization_id,
          device_code: row.device_code,
          code_verifier: verifier,
          signature: sign(null, Buffer.from(payload), pair.privateKey).toString("base64"),
        }),
      });
      if (result.status === 409) {
        const error = await result.json();
        if (
          error.detail === "authorization_pending" ||
          error.detail?.code === "authorization_pending"
        )
          return null;
      }
      if (!result.ok) throw new Error("设备授权已失效，请重新连接");
      return {
        origin,
        privateKey,
        credential: zhiliuHostCredentialSchema.parse(await result.json()),
      };
    },
  };
}
