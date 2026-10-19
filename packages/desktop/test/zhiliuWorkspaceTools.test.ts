import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { MAX_WORKSPACE_FILE_BYTES, WorkspaceTools } from "../src/host/zhiliuWorkspaceTools.js";

describe("WorkspaceTools", () => {
  let temporary: string;
  let root: string;
  let tools: WorkspaceTools;

  beforeEach(async () => {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "zhiliu-workspace-tools-")));
    root = path.join(temporary, "project");
    await fs.mkdir(root, { mode: 0o700 });
    tools = await WorkspaceTools.open(root);
  });

  afterEach(async () => {
    await tools?.close();
    // 只删除本用例创建、已确认位于临时目录内的绝对路径。
    const base = await fs.realpath(tmpdir());
    const relative = path.relative(base, temporary);
    if (
      !path.isAbsolute(temporary) ||
      !relative.startsWith("zhiliu-workspace-tools-") ||
      path.isAbsolute(relative) ||
      relative.includes(path.sep)
    ) {
      throw new Error("Unexpected workspace test cleanup target");
    }
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it("publishes bounded capabilities without the selected absolute path", () => {
    expect(tools.info).toEqual({
      name: "project",
      capabilities: ["file_read", "file_write"],
      terminalExec: false,
      isolation: "workspace-path-guard",
    });
    expect(JSON.stringify(tools.info)).not.toContain(temporary);
    expect(Object.isFrozen(tools.info)).toBe(true);
  });

  it("reads UTF-8, creates files and updates only with the current approval fingerprint", async () => {
    expect(await tools.fingerprint("说明.md")).toBeNull();
    const created = await tools.write("说明.md", "你好，织流\n", null);
    const read = await tools.read("说明.md");
    expect(read.content).toBe("你好，织流\n");
    expect(read.sizeBytes).toBe(Buffer.byteLength(read.content));
    expect(created.fingerprint).toBe(read.fingerprint);
    expect(read.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const changed = await tools.write("说明.md", "已审批修改", read.fingerprint);
    expect(changed.fingerprint).not.toBe(read.fingerprint);
    expect((await tools.read("说明.md")).content).toBe("已审批修改");
    expect(await fs.readdir(root)).toEqual(["说明.md"]);
  });

  it("accepts a real nested directory without creating missing parents", async () => {
    await fs.mkdir(path.join(root, "drafts"), { mode: 0o700 });
    await tools.write("drafts/article.md", "draft", null);
    expect((await tools.read("drafts/article.md")).content).toBe("draft");
    await expect(tools.write("missing/article.md", "no", null)).rejects.toMatchObject({
      code: "invalid_path",
    });
    expect(await fs.readdir(root)).toEqual(["drafts"]);
  });

  it.each([
    "../outside.txt",
    "nested/../../outside.txt",
    "/etc/passwd",
    "C:\\outside.txt",
    "C:relative.txt",
    "\\\\server\\share\\a.txt",
    "\\\\?\\C:\\a.txt",
    "file.txt:stream",
    "nested//file.txt",
    "./file.txt",
    "CON.txt",
    "AUX",
    "LPT1.md",
    "COM¹.txt",
    "trailing. ",
    "trailing.",
    "bad\u0000.txt",
    "bad\n.txt",
  ])("rejects path escape or Windows path aliases: %s", async (relativePath) => {
    await expect(tools.read(relativePath)).rejects.toMatchObject({ code: "invalid_path" });
    await expect(tools.write(relativePath, "no", null)).rejects.toMatchObject({
      code: "invalid_path",
    });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each([
    ".env",
    ".ENV.local",
    ".ssh/id_ed25519",
    ".git/config",
    "keys/private.txt",
    "credentials.json",
    "api_key.txt",
    "cert.pem",
    "client.pfx",
    ".npmrc",
    ".codex/config.toml",
  ])("blocks credential paths: %s", async (relativePath) => {
    await expect(tools.fingerprint(relativePath)).rejects.toMatchObject({ code: "sensitive_path" });
  });

  it("refuses binary, malformed UTF-8 and oversized reads without returning content", async () => {
    for (const [name, body] of [
      ["null-byte.txt", Buffer.from([65, 0, 66])],
      ["control.txt", Buffer.from([1, 2, 3])],
      ["bad.txt", Buffer.from([0xc0, 0xaf])],
    ] as const) {
      await fs.writeFile(path.join(root, name), body);
      await expect(tools.read(name)).rejects.toMatchObject({ code: "unsupported_file" });
    }
    await fs.writeFile(
      path.join(root, "large.txt"),
      Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1, 65),
    );
    await expect(tools.read("large.txt")).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("enforces the UTF-8 byte limit on writes and allows the exact bound", async () => {
    await expect(
      tools.write("large.txt", "中".repeat(MAX_WORKSPACE_FILE_BYTES), null),
    ).rejects.toMatchObject({ code: "file_too_large" });
    await expect(tools.write("null-byte.txt", "a\0b", null)).rejects.toMatchObject({
      code: "unsupported_file",
    });
    await tools.write("bound.txt", "a".repeat(MAX_WORKSPACE_FILE_BYTES), null);
    expect((await tools.read("bound.txt")).sizeBytes).toBe(MAX_WORKSPACE_FILE_BYTES);
    expect(await fs.readdir(root)).toEqual(["bound.txt"]);
  });

  it("preserves edits made after approval and leaves no staging files", async () => {
    await fs.writeFile(path.join(root, "draft.md"), "original");
    const approved = await tools.fingerprint("draft.md");
    await fs.writeFile(path.join(root, "draft.md"), "user edit");
    await expect(tools.write("draft.md", "agent edit", approved)).rejects.toMatchObject({
      code: "file_changed",
    });
    expect(await fs.readFile(path.join(root, "draft.md"), "utf8")).toBe("user edit");
    expect(await fs.readdir(root)).toEqual(["draft.md"]);
  });

  it("detects same-content replacement by file identity", async () => {
    const target = path.join(root, "draft.md");
    await fs.writeFile(target, "same");
    const approved = await tools.fingerprint("draft.md");
    await fs.writeFile(path.join(root, "replacement.md"), "same");
    await fs.rename(path.join(root, "replacement.md"), target);
    await expect(tools.write("draft.md", "no", approved)).rejects.toMatchObject({
      code: "file_changed",
    });
  });

  it("detects parent replacement even when the approved file is moved with its inode", async () => {
    const parent = path.join(root, "drafts");
    await fs.mkdir(parent, { mode: 0o700 });
    await fs.writeFile(path.join(parent, "draft.md"), "same inode");
    const approved = await tools.fingerprint("drafts/draft.md");
    await fs.rename(parent, path.join(root, "old-drafts"));
    await fs.mkdir(parent, { mode: 0o700 });
    await fs.rename(path.join(root, "old-drafts", "draft.md"), path.join(parent, "draft.md"));
    await expect(tools.write("drafts/draft.md", "no", approved)).rejects.toMatchObject({
      code: "file_changed",
    });
  });

  it("rejects two concurrent writes admitted with one approval", async () => {
    await fs.writeFile(path.join(root, "draft.md"), "before");
    const approved = await tools.fingerprint("draft.md");
    const results = await Promise.allSettled([
      tools.write("draft.md", "first", approved),
      tools.write("draft.md", "second", approved),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await tools.read("draft.md")).content).toBe("first");
    expect(await fs.readdir(root)).toEqual(["draft.md"]);
  });

  it("does not overwrite a file that appeared after a missing-file approval", async () => {
    expect(await tools.fingerprint("new.md")).toBeNull();
    await fs.writeFile(path.join(root, "new.md"), "external");
    await expect(tools.write("new.md", "no", null)).rejects.toMatchObject({ code: "file_changed" });
    expect((await tools.read("new.md")).content).toBe("external");
  });

  it("rejects directory junctions before following them", async () => {
    const outside = path.join(temporary, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(path.join(outside, "private.txt"), "private");
    await fs.symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(tools.read("linked/private.txt")).rejects.toMatchObject({
      code: "unsupported_file",
    });
    await expect(tools.write("linked/new.txt", "no", null)).rejects.toMatchObject({
      code: "unsupported_file",
    });
    expect(await fs.readdir(outside)).toEqual(["private.txt"]);
  });

  it("rejects hard links to files outside the selected workspace", async () => {
    const outside = path.join(temporary, "outside.md");
    await fs.writeFile(outside, "private");
    await fs.link(outside, path.join(root, "linked.md"));
    await expect(tools.read("linked.md")).rejects.toMatchObject({ code: "unsupported_file" });
    await expect(tools.write("linked.md", "no", null)).rejects.toMatchObject({
      code: "unsupported_file",
    });
    expect(await fs.readFile(outside, "utf8")).toBe("private");
  });

  it("detects replaced roots and requires native selection again", async () => {
    await fs.rename(root, path.join(temporary, "old-project"));
    await fs.mkdir(root, { mode: 0o700 });
    await expect(tools.assertRoot()).rejects.toMatchObject({ code: "workspace_changed" });
    await expect(tools.write("new.txt", "no", null)).rejects.toMatchObject({
      code: "workspace_changed",
    });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects closed workspaces and terminal requests unconditionally", async () => {
    await expect(tools.terminalExec({ command: "whoami", approved: true })).rejects.toMatchObject({
      code: "terminal_unavailable",
    });
    await tools.close();
    await expect(tools.assertRoot()).rejects.toMatchObject({ code: "workspace_changed" });
    await expect(tools.read("a.md")).rejects.toMatchObject({ code: "workspace_changed" });
  });

  it("rejects home, disk-root and linked workspace selections", async () => {
    await expect(WorkspaceTools.open(homedir())).rejects.toMatchObject({ code: "invalid_path" });
    await expect(WorkspaceTools.open(path.parse(root).root)).rejects.toMatchObject({
      code: "invalid_path",
    });
    await fs.symlink(
      root,
      path.join(temporary, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(WorkspaceTools.open(path.join(temporary, "alias"))).rejects.toMatchObject({
      code: "invalid_path",
    });
  });
});
