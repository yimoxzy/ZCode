import { Readable } from "node:stream";
import { zhiliuManagedRuntimeProfileSchema } from "@zcode/shared";

const MAX_STARTUP_LINE_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 30_000;

/** 只消费一行；同一 chunk 内的后续 NDJSON 原样放回，不创建第二条协议读取路径。 */
export async function readManagedStartupLine(input: NodeJS.ReadableStream): Promise<unknown> {
  if (!(input instanceof Readable)) throw new Error("Managed startup requires a readable stream");
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => finish(new Error("Managed startup frame timed out")), STARTUP_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer); input.off("readable", read); input.off("end", ended); input.off("error", failed);
    };
    const finish = (error?: Error, value?: unknown) => { cleanup(); if (error) reject(error); else resolve(value); };
    const ended = () => finish(new Error("Managed startup frame is missing"));
    const failed = () => finish(new Error("Managed startup input failed"));
    const read = () => {
      let chunk: Buffer | string | null;
      while ((chunk = input.read()) !== null) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const newline = buffer.indexOf(10);
        const prefix = newline < 0 ? buffer : buffer.subarray(0, newline);
        size += prefix.length;
        if (size > MAX_STARTUP_LINE_BYTES) return finish(new Error("Managed startup frame is too large"));
        chunks.push(prefix);
        if (newline < 0) continue;
        const rest = buffer.subarray(newline + 1);
        if (rest.length) input.unshift(rest);
        try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { finish(new Error("Managed startup frame is invalid")); }
        return;
      }
    };
    input.on("readable", read); input.once("end", ended); input.once("error", failed); read();
  });
}

export async function readManagedRuntimeProfile(input: NodeJS.ReadableStream) {
  const parsed = zhiliuManagedRuntimeProfileSchema.safeParse(await readManagedStartupLine(input));
  // Schema diagnostics may echo a supplied credential; only emit a stable error.
  if (!parsed.success) throw new Error("Managed runtime profile is invalid");
  return parsed.data;
}

export async function readManagedPrompt(input: NodeJS.ReadableStream): Promise<string> {
  const value = await readManagedStartupLine(input);
  if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string" || !value.text.trim()) {
    throw new Error("Managed prompt frame is invalid");
  }
  return value.text;
}
