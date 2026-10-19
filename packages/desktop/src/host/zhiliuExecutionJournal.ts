import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
export type Outcome = {
  status: "completed" | "failed" | "cancelled";
  output: string;
  signature: string;
};
type JournalEntry = {
  digest: string;
  stage: "claimed" | "executing" | "outbox" | "done";
  result?: Outcome;
};
/** 持久 claim 在副作用之前；outbox 只保存用户已确认上传的内容，且用设备私钥派生密钥加密。 */
export class ZhiliuExecutionJournal {
  private outbox = new Map<string, JournalEntry>();
  constructor(
    private directory: string,
    private secret: Buffer,
  ) {}
  private path(id: string) {
    return join(this.directory, `${id}.json`);
  }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe journal directory");
    const files = await fs.readdir(this.directory);
    if (files.length > 10000) throw new Error("Journal requires maintenance");
    for (const name of files) {
      if (!/^[a-f0-9-]{36}\.json$/iu.test(name)) continue;
      const id = name.slice(0, -5),
        entry = await this.read(id);
      if (entry?.stage === "outbox") this.outbox.set(id, entry);
    }
  }
  pendingResults() {
    return Array.from(this.outbox.entries());
  }
  private seal(entry: JournalEntry) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.secret, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(entry), "utf8"), cipher.final()]);
    return JSON.stringify({
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }
  async read(id: string): Promise<JournalEntry | null> {
    let file;
    try {
      file = await fs.open(this.path(id), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 150000)
        throw new Error("Unsafe journal entry");
      const row = JSON.parse(await file.readFile("utf8"));
      const decipher = createDecipheriv("aes-256-gcm", this.secret, Buffer.from(row.iv, "base64"));
      decipher.setAuthTag(Buffer.from(row.tag, "base64"));
      const value: JournalEntry = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(row.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
      if (
        !/^[a-f0-9]{64}$/u.test(value.digest) ||
        !["claimed", "executing", "outbox", "done"].includes(value.stage)
      )
        throw new Error("Invalid journal");
      return value;
    } finally {
      await file.close();
    }
  }
  async write(id: string, entry: JournalEntry, exclusive = false) {
    const path = this.path(id),
      temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    const file = await fs.open(exclusive ? path : temp, "wx", 0o600);
    try {
      await file.writeFile(this.seal(entry));
      await file.sync();
    } finally {
      await file.close();
    }
    if (!exclusive) {
      try {
        await fs.rename(temp, path);
      } finally {
        await fs.rm(temp, { force: true });
      }
    }
    if (process.platform !== "win32") {
      const dir = await fs.open(this.directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    if (entry.stage === "outbox") this.outbox.set(id, entry);
    else this.outbox.delete(id);
  }
}
