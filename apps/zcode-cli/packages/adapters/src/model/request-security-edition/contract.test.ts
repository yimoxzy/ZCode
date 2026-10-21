import { describe, expect, it } from "vitest";
import { createModelRequestSecurityState } from "./index.js";

describe("request security compatibility contract", () => {
  it("preserves ordinary upstream transport when no managed profile is injected", () => {
    const transport: typeof fetch = async () => new Response("ordinary transport");
    const security = createModelRequestSecurityState().createExecution({});
    expect(security.protectTransport({providerId: "ordinary", providerConfig: {} as never, transport})).toBe(transport);
  });
});
