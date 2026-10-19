import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { transformZhiliuRendererHtml } from "../scripts/zhiliu-renderer-branding.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const logoSvg = readFileSync(resolve(desktopRoot, "build/zhiliu/icon.svg"), "utf8");

describe("织流首帧及辅助页面品牌", () => {
  it("loads the platform mark and title before React or preload starts", () => {
    const original = readFileSync(resolve(desktopRoot, "src/renderer/index.html"), "utf8");
    const html = transformZhiliuRendererHtml(original, { enabled: true, logoSvg });
    const document = new JSDOM(html).window.document;
    expect(document.title).toBe("织流");
    const logo = document.querySelector("#loading .startup-logo");
    expect(logo?.getAttribute("viewBox")).toBe("0 0 32 32");
    expect(logo?.querySelector("path")?.getAttribute("stroke")).toBe("#24839b");
    expect(document.querySelectorAll("#loading svg")).toHaveLength(1);
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(decodeURIComponent(favicon?.getAttribute("href")?.split(",")[1] || "")).toBe(logoSvg);
    expect(html).toContain('"zcode-react-startup-ready"');
    expect(transformZhiliuRendererHtml(original, { enabled: false })).toBe(original);
  });

  it.each(["plugin-sandbox", "cua-permission-panel"])("brands the %s static page", (name) => {
    const original = readFileSync(resolve(desktopRoot, `src/renderer/${name}.html`), "utf8");
    const document = new JSDOM(transformZhiliuRendererHtml(original, { enabled: true, logoSvg }))
      .window.document;
    expect(document.title).toContain("织流");
    expect(document.title).not.toContain("ZCode");
    expect(document.querySelector("#appName")?.textContent || "").not.toContain("ZCode");
  });
});
