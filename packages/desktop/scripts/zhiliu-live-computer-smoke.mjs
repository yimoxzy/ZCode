import { build } from "esbuild";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const buildOnly = process.argv.slice(2).includes("--build-only");
const validArguments = process.argv.slice(2).every((value) => value === "--build-only");
if (!validArguments) {
  process.stderr.write("Usage: node zhiliu-live-computer-smoke.mjs [--build-only]\n");
  process.exitCode = 1;
} else {
  const tempRoot = await realpath(tmpdir());
  const scratch = await mkdtemp(join(tempRoot, "zhiliu-live-computer-"));
  let summary;
  try {
    const output = join(scratch, "fixture.mjs");
    await build({
      entryPoints: [join(import.meta.dirname, "zhiliu-live-computer-fixture.ts")],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });
    if (buildOnly) {
      summary = { passed: true, checks: 1, note: "Source bundle only; no service requests." };
    } else {
      const { runLiveComputerSmoke } = await import(pathToFileURL(output).href);
      summary = await runLiveComputerSmoke(scratch);
    }
  } catch (error) {
    // 不打印原始异常/响应，避免 assert 或 HTTP 错误泄漏内存中的测试凭据。
    const note = /^Live computer smoke failed at [a-z-]+$/u.test(error?.message ?? "")
      ? error.message
      : "Live computer smoke failed; no credentials were printed.";
    summary = { passed: false, note };
    const diagnostics = error?.diagnostics;
    if (diagnostics) {
      summary.counts = Object.fromEntries(
        [
          "checks",
          "operationReviews",
          "resultReviews",
          "lastAccountStatus",
          "lastHostStatus",
          "invalidHostRows",
        ].map((key) => [key, Number.isSafeInteger(diagnostics[key]) ? diagnostics[key] : 0]),
      );
      summary.reviewFailed = diagnostics.reviewFailed === true;
      summary.schemaIssue = [
        "id",
        "device_id",
        "user_id",
        "space_id",
        "nonce",
        "tool",
        "arguments",
        "status",
        "expires_at",
        "other",
      ].includes(diagnostics.schemaIssue)
        ? diagnostics.schemaIssue
        : "none";
    }
    process.exitCode = 1;
  } finally {
    try {
      await removeScratch(scratch, tempRoot);
    } catch {
      summary = { passed: false, note: "Temporary smoke directory cleanup failed." };
      process.exitCode = 1;
    }
  }
  (process.exitCode ? process.stderr : process.stdout).write(`${JSON.stringify(summary)}\n`);
}

async function removeScratch(scratch, tempRoot) {
  // 仅删除本脚本由 mkdtemp 创建的绝对目录，不接受外部传入清理路径。
  if (
    dirname(resolve(scratch)) !== tempRoot ||
    !basename(scratch).startsWith("zhiliu-live-computer-")
  ) {
    throw new Error("Unsafe smoke cleanup target");
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
