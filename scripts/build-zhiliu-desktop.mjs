import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveZhiliuCloudTarget } from "../packages/desktop/src/main/zhiliuCloudPolicy.ts";
import { resolveZhiliuUpdateBuildPolicy } from "../packages/desktop/src/main/zhiliuUpdatePolicy.ts";
import { runCommand } from "./spawn-command.mjs";

/** One build identity for main/Host/renderer/installer; never embed a model key. */
export function createZhiliuBuildEnv(env = process.env) {
  const target = resolveZhiliuCloudTarget(env.ZHILIU_CLOUD_URL);
  const updatePolicy = resolveZhiliuUpdateBuildPolicy(env);
  return {
    ...env,
    ZHILIU_DESKTOP: "1",
    ZHILIU_CLOUD_URL: target.url,
    ZHILIU_UPDATE_MANIFEST_URL: updatePolicy.manifestUrl ?? "",
    ZHILIU_UPDATE_INSTALL_ENABLED: updatePolicy.installEnabled ? "1" : "0",
    ZHILIU_UPDATE_PUBLISHER_NAME: updatePolicy.publisherName ?? "",
    ZCODE_ENV: "production",
    ZCODE_AUTO_UPDATE: "false",
    ZCODE_ARMS_RUM_ENDPOINT: "",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "",
    ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT: "",
    ZCODE_PACKAGED_AGENT_OTEL_HEADERS: "",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("The Zhiliu desktop build requires Node.js 24 or newer");
  }
  runCommand("pnpm", ["bundle:desktop", "--", ...process.argv.slice(2)], {
    cwd: resolve(import.meta.dirname, ".."),
    env: createZhiliuBuildEnv(),
  });
}
