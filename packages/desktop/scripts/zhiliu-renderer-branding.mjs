/** 在 HTML 加载前应用品牌，避免首帧闪现上游标识；不改内部事件名或技术标识。 */
export function transformZhiliuRendererHtml(html, { enabled, logoSvg }) {
  if (!enabled) return html;
  if (!logoSvg?.includes("<svg") || !logoSvg.includes("#24839b")) {
    throw new Error("Zhiliu renderer branding requires the existing platform logo");
  }
  let branded = html.replace(
    /<title>([^<]*)<\/title>/u,
    (_match, title) => `<title>${title.replaceAll("ZCode", "织流")}</title>`,
  );
  if (branded.includes('class="startup-logo"')) {
    const startupLogo = logoSvg.replace("<svg ", '<svg class="startup-logo" aria-hidden="true" ');
    branded = branded.replace(/<svg\s[\s\S]*?class="startup-logo"[\s\S]*?<\/svg>/u, startupLogo);
    branded = branded.replace(
      "</head>",
      "<style>.startup-logo-shell{background:#fff}.startup-logo-shell::before{border-color:rgba(36,131,155,.12)}</style></head>",
    );
  }
  branded = branded.replaceAll(">ZCode Computer Use<", ">织流 Computer Use<");
  const favicon = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(logoSvg)}" />`;
  return branded.replace("</head>", `${favicon}</head>`);
}
