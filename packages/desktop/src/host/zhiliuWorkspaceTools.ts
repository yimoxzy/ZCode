import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const MAX_WORKSPACE_FILE_BYTES = 64 * 1024;
export type WorkspaceToolErrorCode =
  | "invalid_path"
  | "sensitive_path"
  | "workspace_changed"
  | "file_changed"
  | "unsupported_file"
  | "file_too_large"
  | "io_error"
  | "terminal_unavailable";

export class WorkspaceToolError extends Error {
  constructor(
    readonly code: WorkspaceToolErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkspaceToolError";
  }
}

export interface WorkspaceFileResult {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  fingerprint: string;
}

interface ParentAccess {
  target: string;
  check: () => Promise<void>;
  identity: string;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0);
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sameIdentity = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
const versionFields = ["size", "mtimeNs", "ctimeNs", "mode", "nlink"] as const;
const sameVersion = (left: BigIntStats, right: BigIntStats) =>
  sameIdentity(left, right) && versionFields.every((field) => left[field] === right[field]);
const statIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.birthtimeNs].join(":");
const statVersion = (stat: BigIntStats) =>
  `${statIdentity(stat)}:${versionFields.map((field) => stat[field]).join(":")}`;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const samePath = (left: string, right: string) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const hasControlCharacters = (value: string) =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const within = (base: string, candidate: string) => {
  const relative = path.relative(path.resolve(base), candidate);
  return (
    !relative ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

function fail(code: WorkspaceToolErrorCode, message: string): never {
  throw new WorkspaceToolError(code, message);
}

function safeIoFailure(error: unknown): never {
  if (error instanceof WorkspaceToolError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    throw new WorkspaceToolError("invalid_path", "The file or parent is unavailable", error);
  }
  throw new WorkspaceToolError("io_error", "The workspace operation could not complete", error);
}

function sensitiveName(value: string): boolean {
  const name = value.normalize("NFKC").toLowerCase();
  return (
    /^\.env(?:[._-]|$)/u.test(name) ||
    [".ssh", ".git", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".codex"].includes(name) ||
    /^(?:\.npmrc|\.netrc|\.pypirc|authorized_keys|known_hosts|sam|security)$/u.test(name) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|keys?)(?:[._-]|$)/u.test(name) ||
    /(?:^|[._-])(?:secrets?|credentials?|tokens?)(?:[._-]|$)/u.test(name) ||
    /api[-_]?(?:key|token)/u.test(name) ||
    /\.(?:pem|key|p12|pfx|keystore|kdbx)$/u.test(name)
  );
}

function relativeParts(relativePath: string): string[] {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.length > 1024 ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes(":") ||
    hasControlCharacters(relativePath)
  )
    fail("invalid_path", "Use a relative workspace file path");
  const parts = relativePath.split(/[/\\]/u);
  for (const part of parts) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[. ]$/u.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)
    )
      fail("invalid_path", "The file path contains an unsupported component");
    if (sensitiveName(part)) fail("sensitive_path", "Credential files are unavailable");
  }
  return parts;
}

function usable(stat: BigIntStats, directory = false): void {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
    fail("unsupported_file", "Only real directories and regular files are supported");
  }
  if (!directory && stat.nlink !== 1n)
    fail("unsupported_file", "Hard-linked files are unavailable");
  if (process.platform !== "win32" && (stat.mode & 0o022n) !== 0n) {
    fail("unsupported_file", "Entries writable by other users are unavailable");
  }
}

function validateText(buffer: Uint8Array): string {
  if (buffer.byteLength > MAX_WORKSPACE_FILE_BYTES)
    fail("file_too_large", "Files are limited to 64 KiB");
  if (
    buffer.some((byte) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)
  ) {
    fail("unsupported_file", "Only UTF-8 text files are supported");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return fail("unsupported_file", "Only valid UTF-8 text files are supported");
  }
}

async function openDir(name: string, expected: BigIntStats): Promise<FileHandle | null> {
  if (process.platform === "win32") return null;
  const handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
  if (!sameIdentity(expected, await handle.stat({ bigint: true }))) {
    await handle.close();
    fail("workspace_changed", "A workspace directory changed during access");
  }
  return handle;
}

/** Host-only path guard. It does not provide an operating-system sandbox or execute a CLI. */
export class WorkspaceTools {
  readonly info;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly rootStat: BigIntStats,
    private readonly rootHandle: FileHandle | null,
  ) {
    this.info = Object.freeze({
      name: path.basename(root),
      capabilities: Object.freeze(["file_read", "file_write"] as const),
      terminalExec: false as const,
      isolation: "workspace-path-guard" as const,
    });
  }

  static async open(selectedPath: string): Promise<WorkspaceTools> {
    return this.openSelected(selectedPath).catch(safeIoFailure);
  }

  private static async openSelected(selectedPath: string): Promise<WorkspaceTools> {
    if (
      typeof selectedPath !== "string" ||
      !path.isAbsolute(selectedPath) ||
      hasControlCharacters(selectedPath) ||
      (process.platform === "win32" && !/^[a-z]:[\\/]/iu.test(selectedPath))
    )
      fail("invalid_path", "Choose a project folder with the native directory picker");
    const selected = path.resolve(selectedPath);
    const volumeRoot = path.parse(selected).root;
    const selectedParts = selected.slice(volumeRoot.length).split(path.sep).filter(Boolean);
    if (selectedParts.some(sensitiveName))
      fail("sensitive_path", "Sensitive folders cannot be workspaces");
    let ancestor = volumeRoot;
    for (const part of selectedParts) {
      ancestor = path.join(ancestor, part);
      const stat = await fs.lstat(ancestor, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory())
        fail("invalid_path", "Linked folders cannot be workspaces");
    }
    const root = await fs.realpath(selected);
    if (!samePath(selected, root)) fail("invalid_path", "Choose a real project directory");
    const home = await fs.realpath(homedir());
    if (within(root, home)) {
      fail("invalid_path", "Choose a project folder, not a home or disk root");
    }
    if (samePath(root, volumeRoot)) fail("invalid_path", "Disk roots cannot be workspaces");
    const blocked =
      process.platform === "win32"
        ? [process.env.SystemRoot, process.env.ProgramFiles, process.env.ProgramData].filter(
            (value): value is string => !!value,
          )
        : "/etc /proc /sys /dev /usr /bin /sbin /lib /var /run /boot /System".split(" ");
    if (blocked.some((base) => within(base, root)))
      fail("sensitive_path", "System folders cannot be workspaces");
    const stat = await fs.lstat(root, { bigint: true });
    usable(stat, true);
    return new WorkspaceTools(root, stat, await openDir(root, stat));
  }

  async assertRoot(): Promise<void> {
    if (this.closed) fail("workspace_changed", "The workspace is closed; choose it again");
    let stat: BigIntStats;
    try {
      stat = await fs.lstat(this.root, { bigint: true });
    } catch {
      return fail("workspace_changed", "The workspace was moved or removed; choose it again");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail("workspace_changed", "The workspace directory was replaced");
    usable(stat, true);
    const actual = await fs.realpath(this.root).catch(safeIoFailure);
    if (!sameIdentity(this.rootStat, stat) || !samePath(actual, this.root)) {
      fail("workspace_changed", "The workspace changed; choose it again");
    }
  }

  private anchor(handle: FileHandle | null, absolute: string): string {
    return process.platform === "linux" && handle ? `/proc/self/fd/${handle.fd}` : absolute;
  }

  private async parent<T>(
    relativePath: string,
    run: (access: ParentAccess) => Promise<T>,
  ): Promise<T> {
    const parts = relativeParts(relativePath);
    await this.assertRoot();
    const chain: Array<{ absolute: string; stat: BigIntStats; handle: FileHandle | null }> = [];
    let current = this.rootHandle;
    let absolute = this.root;
    try {
      for (const part of parts.slice(0, -1)) {
        const candidate = path.join(this.anchor(current, absolute), part);
        absolute = path.join(absolute, part);
        const stat = await fs.lstat(candidate, { bigint: true });
        usable(stat, true);
        if (stat.dev !== this.rootStat.dev)
          fail("unsupported_file", "Cross-filesystem paths are unavailable");
        current = await openDir(candidate, stat);
        chain.push({ absolute, stat, handle: current });
      }
      const check = async () => {
        await this.assertRoot();
        for (const item of chain) {
          const stat = await fs.lstat(item.absolute, { bigint: true });
          usable(stat, true);
          if (
            !sameIdentity(item.stat, stat) ||
            !samePath(await fs.realpath(item.absolute), item.absolute)
          ) {
            fail("workspace_changed", "A workspace folder changed during access");
          }
          if (
            process.platform === "linux" &&
            item.handle &&
            (await fs.readlink(`/proc/self/fd/${item.handle.fd}`)) !== item.absolute
          ) {
            fail("workspace_changed", "A workspace folder moved during access");
          }
        }
      };
      await check();
      const identity = [this.rootStat, ...chain.map((item) => item.stat)]
        .map(statIdentity)
        .join("/");
      return await run({
        target: path.join(this.anchor(current, absolute), parts.at(-1)!),
        check,
        identity,
      });
    } finally {
      await Promise.all(chain.map((item) => item.handle?.close()));
    }
  }

  async read(relativePath: string): Promise<WorkspaceFileResult & { content: string }> {
    return this.parent(relativePath, async ({ target, check, identity: parentIdentity }) => {
      const before = await fs.lstat(target, { bigint: true });
      usable(before);
      const namedPath = path.join(this.root, ...relativeParts(relativePath));
      if (!samePath(await fs.realpath(target), namedPath))
        fail("sensitive_path", "File aliases are unavailable");
      if (before.dev !== this.rootStat.dev)
        fail("unsupported_file", "Cross-filesystem files are unavailable");
      if (before.size > BigInt(MAX_WORKSPACE_FILE_BYTES))
        fail("file_too_large", "Files are limited to 64 KiB");
      const file = await fs.open(target, READ_FLAGS);
      try {
        const opened = await file.stat({ bigint: true });
        usable(opened);
        if (!sameVersion(before, opened)) fail("file_changed", "The file changed during open");
        await check();
        const buffer = Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        const content = validateText(bytes);
        const after = await file.stat({ bigint: true });
        const named = await fs.lstat(target, { bigint: true });
        usable(named);
        if (!sameVersion(before, after) || !sameVersion(after, named))
          fail("file_changed", "The file changed while reading");
        await check();
        const sha256 = hash(bytes);
        const fingerprint = hash(`${parentIdentity}:${statVersion(named)}:${sha256}`);
        return { relativePath, content, sizeBytes: length, sha256, fingerprint };
      } finally {
        await file.close();
      }
    }).catch(safeIoFailure);
  }

  async fingerprint(relativePath: string): Promise<string | null> {
    return this.parent(relativePath, async ({ target, check }) => {
      try {
        await fs.lstat(target);
      } catch (error) {
        if (!isMissing(error)) throw error;
        await check();
        return null;
      }
      return (await this.read(relativePath)).fingerprint;
    }).catch(safeIoFailure);
  }

  write(
    relativePath: string,
    content: string,
    expectedFingerprint: string | null,
  ): Promise<WorkspaceFileResult> {
    const result = this.writes
      .then(() => this.commitWrite(relativePath, content, expectedFingerprint))
      .catch(safeIoFailure);
    this.writes = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async commitWrite(
    relativePath: string,
    content: string,
    expectedFingerprint: string | null,
  ): Promise<WorkspaceFileResult> {
    if (
      typeof content !== "string" ||
      (expectedFingerprint !== null && !/^[a-f0-9]{64}$/u.test(expectedFingerprint))
    ) {
      fail("unsupported_file", "A valid text body and approval fingerprint are required");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_WORKSPACE_FILE_BYTES)
      fail("file_too_large", "Files are limited to 64 KiB");
    const bytes = Buffer.from(content, "utf8");
    validateText(bytes);
    // 原生审批前取得的文件身份必须在排队后、提交前分别重验，避免覆盖审批期间的编辑。
    if ((await this.fingerprint(relativePath)) !== expectedFingerprint)
      fail("file_changed", "The file changed since approval");
    return this.parent(relativePath, async ({ target, check }) => {
      const temporary = path.join(path.dirname(target), `.zhiliu-${randomUUID()}.tmp`);
      let staged: FileHandle | undefined;
      try {
        staged = await fs.open(temporary, WRITE_FLAGS, 0o600);
        await staged.writeFile(bytes);
        await staged.sync();
        await staged.close();
        staged = undefined;
        await check();
        if ((await this.fingerprint(relativePath)) !== expectedFingerprint)
          fail("file_changed", "The file changed since approval");
        // 新文件使用 no-replace 提交；既有目标 rename 的最终校验不是 OS 级 compare-and-swap。
        if (expectedFingerprint === null) {
          try {
            await fs.link(temporary, target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
              fail("file_changed", "The file appeared since approval");
            throw error;
          }
          await fs.unlink(temporary);
        } else await fs.rename(temporary, target);
        await check();
        const { content: _content, ...result } = await this.read(relativePath);
        return result;
      } finally {
        await staged?.close();
        await fs.unlink(temporary).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
      }
    });
  }

  async terminalExec(..._arguments: unknown[]): Promise<never> {
    return fail("terminal_unavailable", "No OS sandbox; terminal execution is unavailable");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writes;
    await this.rootHandle?.close();
  }
}
