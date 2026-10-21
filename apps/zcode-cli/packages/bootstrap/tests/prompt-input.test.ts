import { describe, expect, it, vi } from "vitest";
import { externalizePromptAttachments, projectInputHistoryAttachments } from "../src/app/prompt-input.js";
import { createInputFacade } from "../src/app/input-facade.js";
import type { ToolArtifactStorePort } from "@zcode/contracts";

describe("managed inline attachment persistence", () => {
  const attachments = [{type: "image" as const, content: "data:image/png;base64,aW1hZ2U="}];
  const options = {sessionId: "test-session" as never, traceContext: {} as never, requirePersistence: true};
  it("fails closed for missing store, write failure and invalid artifact identity", async () => {
    await expect(externalizePromptAttachments(attachments, options)).rejects.toThrow("Managed prompt attachment persistence failed");
    for (const write of [async () => {throw new Error("private storage path");},
      ...["https://outside.invalid", "zcode-artifact://test-session/", "zcode-artifact://other-session/image"]
        .map(uri => async () => ({uri}))]) {
      await expect(externalizePromptAttachments(attachments, {...options,
        artifactStore: {writeToolResultArtifact: write} as unknown as ToolArtifactStorePort,
      })).rejects.toThrow(/^Managed prompt attachment persistence failed$/);
    }
  });
  it("reuses durable artifact refs and preserves ordinary local failure compatibility", async () => {
    const artifactStore = {writeToolResultArtifact: async () => ({uri: "zcode-artifact://test-session/image"})} as unknown as ToolArtifactStorePort;
    await expect(externalizePromptAttachments(attachments, {...options, artifactStore}))
      .resolves.toEqual([{type: "image", content: "zcode-artifact://test-session/image"}]);
    await expect(externalizePromptAttachments(attachments, {...options, requirePersistence: false}))
      .resolves.toEqual([{type: "image"}]);
  });
  it("does not admit a model turn when managed externalization fails", async () => {
    const executeTurn = vi.fn();
    const facade = createInputFacade({
      ...options, requireAttachmentPersistence: true,
      prepareUserExecutionBoundary: async () => {},
      runtime: {executeTurn} as never, logger: {} as never,
      artifactStore: {writeToolResultArtifact: async () => {throw new Error("unavailable");}} as unknown as ToolArtifactStorePort,
    });
    await expect(facade.submitPrompt({text: "describe", attachments})).rejects.toThrow("Managed prompt attachment persistence failed");
    expect(executeTurn).not.toHaveBeenCalled();
  });
});

describe("projectInputHistoryAttachments", () => {
  it("只把 legacy input history 支持的附件投影到存储契约", () => {
    expect(
      projectInputHistoryAttachments([
        {
          content: "zcode-artifact://session/image",
          path: "[image #1]",
          type: "image",
        },
        {
          content: "data:video/mp4;base64,dmlkZW8=",
          path: "[video #1]",
          type: "video",
        },
        {
          path: "/tmp/notes.txt",
          sourceKind: "clipboard-text",
          type: "file",
        },
        {
          content: "https://example.com",
          type: "url",
        },
      ]),
    ).toEqual([
      {
        content: "zcode-artifact://session/image",
        path: "[image #1]",
        type: "image",
      },
      {
        path: "/tmp/notes.txt",
        type: "file",
      },
      {
        content: "https://example.com",
        type: "url",
      },
    ]);
  });

  it("没有可持久化附件时返回 undefined", () => {
    expect(
      projectInputHistoryAttachments([
        {
          content: "data:video/mp4;base64,dmlkZW8=",
          type: "video",
        },
      ]),
    ).toBeUndefined();
  });
});
