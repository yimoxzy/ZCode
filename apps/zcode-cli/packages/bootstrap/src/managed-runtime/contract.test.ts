import { describe, expect, it } from "vitest";
import { exampleSelection } from "./contract.example.js";
import { MANAGED_MODEL_ID } from "./contract.js";
describe("managed runtime contract", () => {
  it("只发布平台虚拟模型身份", () => {
    expect(exampleSelection.modelId).toBe(MANAGED_MODEL_ID);
  });
});
