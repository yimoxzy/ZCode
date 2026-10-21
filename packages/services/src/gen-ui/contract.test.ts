import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IGenUiService } from "./contract.js";
import { exampleGenUiPrepare } from "./contract.example.js";
import { createGenUiService } from "./node.js";

describe("Gen UI public service contract", () => {
  it("keeps widget state scoped to the selected workspace identity and session", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "gen-ui-contract-"));
    const runtime = createGenUiService({ stateRoot });
    const service: IGenUiService = runtime;
    const target = {
      workspacePath: "/workspace",
      workspaceIdentity: "device-a:workspace",
      sessionId: "session-a",
      path: "/workspace/chart.html",
    };
    const state = { modelContent: { selected: "sales" }, privateContent: { selectedRow: 2 } };
    try {
      await service.setState({ target, state });
      expect(await service.getState(target)).toEqual(state);
      expect(
        await service.getState({ ...target, workspaceIdentity: "device-b:workspace" }),
      ).toBeNull();
      expect(await service.getState({ ...target, sessionId: "session-b" })).toBeNull();
      expect(
        await service.listState({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: target.sessionId,
        }),
      ).toHaveLength(1);
    } finally {
      runtime.dispose();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
  it("requires a desktop sandbox owner for prepared content", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "gen-ui-contract-"));
    const runtime = createGenUiService({ stateRoot });
    try {
      await expect(runtime.prepareSandbox(exampleGenUiPrepare)).rejects.toThrow("desktop sandbox");
    } finally {
      runtime.dispose();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
