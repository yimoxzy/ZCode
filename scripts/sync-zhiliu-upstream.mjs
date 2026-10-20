import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function prepareZhiliuUpstreamSync({
  cwd,
  ref = "origin/main",
  directory,
  branch,
  fetch = true,
}) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const upstreamUrl = git(root, ["remote", "get-url", "origin"]);
  if (
    !/^(https:\/\/github\.com\/|git@github\.com:)zai-org\/ZCode(?:\.git)?\/?$/i.test(upstreamUrl)
  ) {
    throw new Error("origin 必须指向官方 zai-org/ZCode；本命令不会修改 remote。");
  }
  if (git(root, ["status", "--porcelain"])) {
    throw new Error("源工作树有未提交改动，请先保存；不会覆盖或自动暂存。");
  }
  if (fetch) git(root, ["fetch", "--no-tags", "origin", "main"]);
  const upstream = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const source = git(root, ["rev-parse", "HEAD"]);
  try {
    git(root, ["merge-base", "--is-ancestor", upstream, source]);
    return { status: "already-current", source, upstream, directory: root };
  } catch {
    // 上游不是当前祖先时才创建独立集成目录；绝不重置产品工作树。
  }
  const integrationBranch = branch ?? `zhiliu/upstream-${upstream.slice(0, 8)}`;
  git(root, ["check-ref-format", "--branch", integrationBranch]);
  const target = resolve(
    directory ?? resolve(dirname(root), `zhiliu-zcode-sync-${upstream.slice(0, 8)}`),
  );
  git(root, ["worktree", "add", "-b", integrationBranch, target, source]);
  try {
    git(target, ["merge", "--no-commit", "--no-ff", upstream]);
  } catch (error) {
    const conflicts = git(target, ["diff", "--name-only", "--diff-filter=U"])
      .split(/\r?\n/)
      .filter(Boolean);
    if (!conflicts.length) throw error;
    return {
      status: "conflicts",
      source,
      upstream,
      directory: target,
      branch: integrationBranch,
      conflicts,
    };
  }
  return {
    status: "ready-for-validation",
    source,
    upstream,
    directory: target,
    branch: integrationBranch,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = { cwd: resolve(import.meta.dirname, "..") };
    for (let index = 0; index < args.length; index++) {
      const option = args[index];
      // pnpm run 会把额外的 -- 原样转发；保留文档中的标准参数分隔写法。
      if (option === "--") continue;
      if (option === "--no-fetch") options.fetch = false;
      else if (["--ref", "--directory", "--branch"].includes(option) && args[index + 1]) {
        options[option.slice(2)] = args[++index];
      } else throw new Error(`未知或不完整参数：${option}`);
    }
    const result = prepareZhiliuUpstreamSync(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "already-current") {
      console.log(
        "在集成目录解决冲突后，安装固定依赖并运行 typecheck、lint、architecture:check --changed 和相关回归；验证通过后再提交。",
      );
    }
    if (result.status === "conflicts") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
