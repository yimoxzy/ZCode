import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { prepareZhiliuUpstreamSync } from "../sync-zhiliu-upstream.mjs";

function fixture(context) {
  const group = mkdtempSync(join(tmpdir(), "zhiliu-sync-"));
  const directory = join(group, "repo");
  mkdirSync(directory);
  context.after(() => {
    const withinTemp = relative(tmpdir(), group);
    assert.ok(withinTemp && !withinTemp.startsWith("..") && !isAbsolute(withinTemp));
    rmSync(group, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=product");
  git("config", "user.email", "sync-test@example.invalid");
  git("config", "user.name", "Sync test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "disabled-hooks");
  git("remote", "add", "origin", "https://github.com/zai-org/ZCode.git");
  writeFileSync(join(directory, "shared.txt"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  return { directory, git, base };
}

test("clean sync keeps the product checkout unchanged and preserves both histories", (context) => {
  const { directory, git } = fixture(context);
  git("checkout", "-b", "upstream");
  writeFileSync(join(directory, "upstream.txt"), "new runtime\n");
  git("add", ".");
  git("commit", "-m", "upstream update");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "product");
  writeFileSync(join(directory, "product.txt"), "managed policy\n");
  git("add", ".");
  git("commit", "-m", "product boundary");
  const before = git("rev-parse", "HEAD");
  const result = prepareZhiliuUpstreamSync({
    cwd: directory,
    fetch: false,
    directory: `${directory}-integration`,
  });
  assert.equal(result.status, "ready-for-validation");
  assert.equal(git("rev-parse", "HEAD"), before);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(
    execFileSync("git", ["rev-parse", "MERGE_HEAD"], {
      cwd: result.directory,
      encoding: "utf8",
    }).trim(),
    result.upstream,
  );
});

test("conflicts stop in the integration worktree without choosing either side", (context) => {
  const { directory, git } = fixture(context);
  git("checkout", "-b", "upstream");
  writeFileSync(join(directory, "shared.txt"), "upstream\n");
  git("add", ".");
  git("commit", "-m", "upstream policy");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "product");
  writeFileSync(join(directory, "shared.txt"), "product\n");
  git("add", ".");
  git("commit", "-m", "product policy");
  const result = prepareZhiliuUpstreamSync({
    cwd: directory,
    fetch: false,
    directory: `${directory}-integration`,
  });
  assert.equal(result.status, "conflicts");
  assert.deepEqual(result.conflicts, ["shared.txt"]);
  assert.equal(git("status", "--porcelain"), "");
});

test("dirty worktrees and a wrong upstream are rejected; an existing ancestor is a no-op", (context) => {
  const { directory, git, base } = fixture(context);
  git("update-ref", "refs/remotes/origin/main", base);
  assert.equal(
    prepareZhiliuUpstreamSync({ cwd: directory, fetch: false }).status,
    "already-current",
  );
  writeFileSync(join(directory, "draft.txt"), "unfinished\n");
  assert.throws(() => prepareZhiliuUpstreamSync({ cwd: directory, fetch: false }), /未提交/);
  git("remote", "set-url", "origin", "https://example.invalid/other.git");
  assert.throws(() => prepareZhiliuUpstreamSync({ cwd: directory, fetch: false }), /官方/);
});
