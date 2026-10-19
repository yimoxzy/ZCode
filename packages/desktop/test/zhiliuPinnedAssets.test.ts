import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const assetsRoot = "apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/";
const tweakPath = "packages/desktop/src/renderer/src/plugin-sandbox/genUiTweakRuntime.js";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it("preserves pinned Gen UI resources after a real Git checkout with Windows autocrlf enabled", async () => {
  const vendor = JSON.parse(
    await readFile(join(repositoryRoot, assetsRoot, "vendor/manifest.json"), "utf8"),
  ) as {
    resources: { file: string; sha256: string; licenseFile: string; licenseSha256: string }[];
  };
  const runtime = JSON.parse(
    await readFile(join(repositoryRoot, assetsRoot, "runtime-manifest.json"), "utf8"),
  ) as {
    files: Record<string, { sha256: string }>;
  };
  const expected = new Map<string, string>();
  for (const resource of vendor.resources) {
    expected.set(`${assetsRoot}vendor/${resource.file}`, resource.sha256);
    expected.set(`${assetsRoot}vendor/${resource.licenseFile}`, resource.licenseSha256);
  }
  for (const [name, entry] of Object.entries(runtime.files)) {
    expected.set(name === "tweak.js" ? tweakPath : `${assetsRoot}${name}`, entry.sha256);
  }
  const fixture = await mkdtemp(join(tmpdir(), "zhiliu-pinned-assets-"));
  try {
    await copyFile(join(repositoryRoot, ".gitattributes"), join(fixture, ".gitattributes"));
    for (const [path, sha256] of expected) {
      const input = await readFile(join(repositoryRoot, path));
      expect(hash(input), `source hash: ${path}`).toBe(sha256);
      await mkdir(dirname(join(fixture, path)), { recursive: true });
      await copyFile(join(repositoryRoot, path), join(fixture, path));
    }
    await execute("git", ["init", "--quiet"], { cwd: fixture });
    await execute("git", ["-c", "core.autocrlf=false", "add", "--", "."], { cwd: fixture });
    for (const path of expected.keys()) await unlink(join(fixture, path));
    await execute("git", ["-c", "core.autocrlf=true", "checkout-index", "--all", "--force"], {
      cwd: fixture,
    });
    for (const [path, sha256] of expected) {
      expect(hash(await readFile(join(fixture, path))), `checkout hash: ${path}`).toBe(sha256);
    }
  } finally {
    expect(dirname(fixture)).toBe(resolve(tmpdir()));
    await rm(fixture, { recursive: true, force: true });
  }
});
