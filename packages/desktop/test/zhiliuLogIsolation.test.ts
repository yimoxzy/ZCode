import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as yauzl from "yauzl";

const state = vi.hoisted(() => ({
  enabled: true,
  home: "",
  paths: null as typeof import("../../services/src/paths.js") | null,
  feedback: vi.fn(async (_options: unknown) => ({ path: "fixture.zip", size: 1 })),
}));
vi.mock("@zcode/shared", async (original) => ({
  ...(await original<typeof import("@zcode/shared")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return state.enabled;
  },
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => state.home,
}));
vi.mock("@zcode/services/node", () => ({
  createFeedbackDiagnosticArchive: state.feedback,
  getAppConfigDir: () => state.paths!.getAppConfigDir(),
  getExportLogDir: () => state.paths!.getExportLogDir(),
  getExportLogStageDir: () => state.paths!.getExportLogStageDir(),
  getFeedbackLogArchiveDir: () => state.paths!.getFeedbackLogArchiveDir(),
  getZCodeDataRootDir: () => state.paths!.getZCodeDataRootDir(),
}));
vi.mock("../src/main/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/main/about.js", () => ({
  createAboutSnapshot: () => ({}),
  readBuildMetadata: () => ({}),
  formatAboutDetail: () => "diagnostic test",
}));

async function write(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function readZip(zipPath: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("missing zip"));
      const entries = new Map<string, string>();
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("missing stream"));
          const chunks: Buffer[] = [];
          stream.on("error", reject);
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.readEntry();
    });
  });
}

beforeEach(async () => {
  vi.resetModules();
  state.enabled = true;
  state.feedback.mockClear();
  state.home = await mkdtemp(join(tmpdir(), "zhiliu-log-isolation-"));
  vi.stubEnv("HOME", state.home);
  vi.stubEnv("ZCODE_DATA_BASE_DIR", "");
  state.paths = await import("../../services/src/paths.js");
});
afterEach(async () => {
  state.paths?.setDataBaseDir(null);
  vi.unstubAllEnvs();
  await rm(state.home, { recursive: true, force: true });
});

describe("zhiliu diagnostic isolation", () => {
  it.each([false, true])(
    "exports only its own logs, never CLI credentials (custom root: %s)",
    async (custom) => {
      if (custom) state.paths!.setDataBaseDir(join(state.home, "custom-brand-root"));
      const oldRoot = join(state.home, ".zcode");
      const ownRoot = state.paths!.getZCodeDataRootDir();
      for (const [root, marker] of [
        [oldRoot, "old-zcode"],
        [ownRoot, "zhiliu"],
      ]) {
        await write(join(root!, "cli", "log", "agent.log"), `${marker}-agent`);
        await write(join(root!, "cli", "rollout", "run.jsonl"), `${marker}-rollout`);
        await write(join(root!, "computer-use", "run", "helper.exit.log"), `${marker}-helper`);
        await write(
          join(root!, "cli", "config.json"),
          JSON.stringify({ arbitrary: `${marker}-private-value` }),
        );
      }
      await write(
        join(ownRoot, "v2", "logs", "main.log"),
        '{"apiKey":"fixture-secret","input_tokens":12}',
      );
      const { createLogArchiveArtifacts, writeLogArchiveZip } =
        await import("../src/main/exportLogs.js");
      const artifacts = await createLogArchiveArtifacts(state.paths!.getAppConfigDir());
      const zipPath = join(state.home, "logs.zip");
      await writeLogArchiveZip(zipPath, artifacts, { stageRootDir: join(state.home, "stage") });
      const entries = await readZip(zipPath);
      expect(entries.get(".zcode/cli/log/agent.log")).toBe("zhiliu-agent");
      expect(entries.get(".zcode/cli/rollout/run.jsonl")).toBe("zhiliu-rollout");
      expect(entries.get(".zcode/computer-use/run/helper.exit.log")).toBe("zhiliu-helper");
      expect(entries.has(".zcode/cli/config.json")).toBe(false);
      expect([...entries.values()].join("\n")).not.toMatch(
        /old-zcode|private-value|fixture-secret/,
      );
      expect(entries.get("logs/main.log")).toContain("***REDACTED***");
      expect(entries.get("logs/main.log")).toContain('"input_tokens":12');
      expect(await readFile(join(oldRoot, "cli", "config.json"), "utf8")).toContain(
        "old-zcode-private-value",
      );
    },
  );

  it("limits feedback sources to the brand root and excludes CLI configuration", async () => {
    const { createFeedbackLogArchiveFromExportLogs } = await import("../src/main/exportLogs.js");
    await createFeedbackLogArchiveFromExportLogs(state.paths!.getAppConfigDir());
    const options = state.feedback.mock.calls[0]![0] as {
      sources: { directory: string; includeFileNames?: string[] }[];
    };
    expect(options.sources).toHaveLength(4);
    expect(
      options.sources.every((source) =>
        source.directory.startsWith(state.paths!.getZCodeDataRootDir()),
      ),
    ).toBe(true);
    expect(options.sources.some((source) => source.includeFileNames?.includes("config.json"))).toBe(
      false,
    );
  });

  it("preserves upstream HOME diagnostics and sanitized CLI configuration", async () => {
    state.enabled = false;
    const oldRoot = join(state.home, ".zcode");
    await write(join(oldRoot, "cli", "log", "agent.log"), "upstream-agent");
    await write(
      join(oldRoot, "cli", "config.json"),
      '{"apiKey":"upstream-fixture-key","model":"glm"}',
    );
    const {
      createLogArchiveArtifacts,
      writeLogArchiveZip,
      createFeedbackLogArchiveFromExportLogs,
    } = await import("../src/main/exportLogs.js");
    const artifacts = await createLogArchiveArtifacts(state.paths!.getAppConfigDir());
    const zipPath = join(state.home, "upstream.zip");
    await writeLogArchiveZip(zipPath, artifacts, { stageRootDir: join(state.home, "stage") });
    const entries = await readZip(zipPath);
    expect(entries.get(".zcode/cli/log/agent.log")).toBe("upstream-agent");
    expect(entries.get(".zcode/cli/config.json")).toContain('"model":"glm"');
    expect(entries.get(".zcode/cli/config.json")).not.toContain("upstream-fixture-key");
    await createFeedbackLogArchiveFromExportLogs(state.paths!.getAppConfigDir());
    const options = state.feedback.mock.calls[0]![0] as {
      sources: { includeFileNames?: string[] }[];
    };
    expect(options.sources.some((source) => source.includeFileNames?.includes("config.json"))).toBe(
      true,
    );
  });

  it("reads model trajectories only from the brand root, without a HOME fallback", async () => {
    const { readModelTrajectory } =
      await import("../../services/src/zcode-agent/modelTrajectory.js");
    const record = (marker: string) =>
      JSON.stringify({
        type: "model_io",
        sessionId: "shared",
        requestId: marker,
        request: { messages: [{ role: "user", content: marker }] },
      });
    const oldFile = join(state.home, ".zcode", "cli", "rollout", "model-io-shared.jsonl");
    await write(oldFile, record("old-zcode"));
    expect((await readModelTrajectory("shared")).records).toEqual([]);
    const ownFile = join(
      state.paths!.getZCodeDataRootDir(),
      "cli",
      "rollout",
      "model-io-shared.jsonl",
    );
    await write(ownFile, record("zhiliu"));
    expect((await readModelTrajectory("shared")).sourceFiles).toEqual([ownFile]);
    state.enabled = false;
    expect((await readModelTrajectory("shared")).sourceFiles).toEqual([oldFile, ownFile]);
  });
});
