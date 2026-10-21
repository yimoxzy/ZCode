import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";

const name = "mcp__zhiliu_platform__save_personal_memory";
const writes = {
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium" as const,
  sideEffectScope: "network" as const,
};
const grant = [
  { behavior: "allow" as const, rules: [{ toolName: name }], type: "addRules" as const },
];
function service() {
  return new PermissionService({
    ...defaultPermissionConfig,
    allowedTools: new Set([name]),
    approvalRequiredTools: new Set([name]),
  });
}

describe("Host required platform write approval", () => {
  it.each(["build", "edit", "yolo", "guarded"] as const)(
    "requires one user response in %s despite all allow sources",
    (mode) => {
      const authority = service();
      authority.grantSessionPermission(grant);
      expect(
        authority.checkPermission(
          { toolName: name, input: {}, riskLevel: "medium", mode },
          writes,
          { version: 1, allow: [{ toolName: name }] },
        ),
      ).toMatchObject({ decision: "ask", approvalMode: "user-once", alwaysAsk: true });
    },
  );
  it("keeps Plan, auto, explicit deny and project deny closed", () => {
    const context = {
      toolName: name,
      input: {},
      riskLevel: "medium" as const,
      mode: "yolo" as const,
    };
    expect(service().checkPermission({ ...context, planEnabled: true }, writes).decision).toBe(
      "deny",
    );
    expect(service().checkPermission({ ...context, mode: "auto" }, writes).decision).toBe("deny");
    expect(
      service().checkPermission(context, writes, { version: 1, deny: [{ toolName: name }] })
        .decision,
    ).toBe("deny");
    const denied = new PermissionService({
      ...defaultPermissionConfig,
      disallowedTools: new Set([name]),
      approvalRequiredTools: new Set([name]),
    });
    expect(denied.checkPermission(context, writes).decision).toBe("deny");
  });
  it("does not change cloud profiles without required approval", () => {
    const ordinary = new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set([name]),
    });
    expect(
      ordinary.checkPermission(
        { toolName: name, input: {}, riskLevel: "medium", mode: "build" },
        writes,
      ).decision,
    ).toBe("allow");
  });

  function harness(mode: CollaborationMode = "yolo") {
    const registry = createToolRegistry();
    const handler = vi.fn(async () => "saved");
    registry.register({
      inputSchema: {},
      metadata: { ...writes, concurrentSafe: false, destructive: false, name },
      handler,
    });
    const requests: PermissionBrokerRequest[] = [];
    let response = Promise.withResolvers<PermissionBrokerResult>();
    const permissionHook = vi.fn();
    const sessionId = createSessionId("managed-write-session");
    const turnId = createTurnId("managed-write-turn");
    const executor = createToolExecutor({
      registry,
      mode,
      sessionId,
      turnId,
      traceContext: createRootTraceContext({ sessionId, turnId }),
      permissionService: service(),
      permissionBroker: {
        requestPermission: (request) => {
          requests.push(request);
          return response.promise;
        },
      },
      hookRunner: {
        run: async (input) => {
          if (input.hookEventName === "PermissionRequest") permissionHook();
          return { additionalContexts: [], permissionBehavior: "allow" as const };
        },
      },
      emitEvent: async () => {},
    });
    let counter = 0;
    return {
      handler,
      requests,
      permissionHook,
      execute: (signal?: AbortSignal) =>
        executor.execute(
          {
            id: createToolCallId(`managed-call-${++counter}`),
            name,
            input: { content: "user confirmed preference" },
          },
          { signal },
        ),
      respond: (result: PermissionBrokerResult) => response.resolve(result),
      next: () => {
        response = Promise.withResolvers<PermissionBrokerResult>();
      },
    };
  }
  it.each(["build", "yolo"] as const)(
    "waits for native UI approval, never hook approval, and asks for every %s call",
    async (mode) => {
      const h = harness(mode);
      const first = h.execute();
      await vi.waitFor(() => expect(h.requests).toHaveLength(1));
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.requests[0]).toMatchObject({
        approvalMode: "user-once",
        suggestedPermissionUpdates: [],
        toolName: name,
      });
      expect(h.permissionHook).not.toHaveBeenCalled();
      h.respond({ decision: "allow" });
      expect((await first).success).toBe(true);
      h.next();
      const second = h.execute();
      await vi.waitFor(() => expect(h.requests).toHaveLength(2));
      expect(h.handler).toHaveBeenCalledOnce();
      h.respond({ decision: "deny" });
      expect((await second).success).toBe(false);
      expect(h.handler).toHaveBeenCalledOnce();
    },
  );
  it.each(["permissionUpdates", "sessionPermissionUpdates"] as const)(
    "rejects attempted persistent %s in yolo",
    async (key) => {
      const h = harness();
      const execution = h.execute();
      await vi.waitFor(() => expect(h.requests).toHaveLength(1));
      h.respond({ decision: "allow", [key]: grant });
      expect((await execution).success).toBe(false);
      expect(h.handler).not.toHaveBeenCalled();
    },
  );
  it("cancels a waiting user-once request and ignores a late approval", async () => {
    const h = harness();
    const controller = new AbortController();
    const execution = h.execute(controller.signal);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    controller.abort();
    expect((await execution).success).toBe(false);
    h.respond({ decision: "allow" });
    await Promise.resolve();
    expect(h.handler).not.toHaveBeenCalled();
  });
});
