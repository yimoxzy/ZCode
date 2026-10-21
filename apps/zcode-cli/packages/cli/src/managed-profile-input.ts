import { Readable } from "node:stream";
import { zhiliuManagedRuntimeProfileSchema } from "@zcode/shared";
import type { ZhiliuManagedRuntimeProfile } from "@zcode/shared";
import type { PromptInput } from "@zcode/bootstrap";
import { detectImageMediaType } from "@zcode/contracts";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";

const MAX_STARTUP_LINE_BYTES = 1024 * 1024;
const MAX_PROMPT_LINE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_TOTAL_PIXELS = 32_000_000;
const MAX_IMAGE_EDGE = 8192;
const STARTUP_TIMEOUT_MS = 30_000;

/** 只消费一行；同一 chunk 内的后续 NDJSON 原样放回，不创建第二条协议读取路径。 */
export async function readManagedStartupLine(input: NodeJS.ReadableStream, maxBytes = MAX_STARTUP_LINE_BYTES): Promise<unknown> {
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
        if (size > maxBytes) return finish(new Error("Managed startup frame is too large"));
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

export async function readManagedPrompt(
  input: NodeJS.ReadableStream,
  profile?: Pick<ZhiliuManagedRuntimeProfile, "supportsImage">,
): Promise<PromptInput> {
  const value = await readManagedStartupLine(input, MAX_PROMPT_LINE_BYTES);
  const invalid = () => new Error("Managed prompt frame is invalid");
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim()) throw invalid();
  if (hasOnlyKeys(value, ["text"])) return value.text;
  if (!hasOnlyKeys(value, ["version", "text", "images"]) || value.version !== 2 ||
    !Array.isArray(value.images) || value.images.length < 1 || value.images.length > 4) throw invalid();
  if (profile?.supportsImage !== true) throw new Error("Managed prompt image input is not enabled");

  let bytes = 0;
  let pixels = 0;
  const images = value.images.map((image: unknown) => {
    if (!isRecord(image) || !hasOnlyKeys(image, ["mediaType", "data"]) ||
      (image.mediaType !== "image/png" && image.mediaType !== "image/jpeg") ||
      typeof image.data !== "string" || !image.data || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      image.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(image.data)) throw invalid();
    const data = Buffer.from(image.data, "base64");
    bytes += data.length;
    if (data.toString("base64") !== image.data || bytes > MAX_IMAGE_BYTES ||
      detectImageMediaType(data) !== image.mediaType) throw invalid();
    const dimensions = imageDimensions(data, image.mediaType);
    if (!dimensions) throw invalid();
    const [width, height] = dimensions;
    pixels += width * height;
    if (!width || !height || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE ||
      width * height > MAX_IMAGE_PIXELS || pixels > MAX_TOTAL_PIXELS) throw invalid();
    return {data, mediaType: image.mediaType, width, height};
  });

  // 先检查全部尺寸预算，再复用原 decoder，避免小压缩体在 Jimp 分配时放大为巨图。
  const processor = createJimpImageProcessorAdapter();
  for (const image of images) {
    try {
      const decoded = await processor.resizeToFit({...image, maxDimension: MAX_IMAGE_EDGE});
      if (decoded.originalWidth !== image.width || decoded.originalHeight !== image.height) throw invalid();
    } catch { throw invalid(); }
  }
  return {text: value.text, attachments: images.map(image => ({type: "image",
    content: `data:${image.mediaType};base64,${image.data.toString("base64")}`,
    mimeType: image.mediaType, sizeBytes: image.data.length}))};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** 只做分配前尺寸检查；真实文件完整性仍交给原有 decoder。 */
function imageDimensions(data: Buffer, mediaType: string): [number, number] | undefined {
  if (mediaType === "image/png") {
    if (data.length < 33 || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") return;
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }
  let dimensions: [number, number] | undefined;
  for (let offset = 2; offset < data.length;) {
    if (data[offset++] !== 0xff) return;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) return offset === data.length ? dimensions : undefined;
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0x01 ||
      marker === 0xdc || (marker >= 0xd0 && marker <= 0xd7)) return;
    if (offset + 2 > data.length) return;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if ((marker !== 0xc0 && marker !== 0xc2) || dimensions || length < 8) return;
      dimensions = [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)];
    }
    offset += length;
    if (marker === 0xda) {
      if (!dimensions) return;
      // 扫过熵编码区的 stuffed/restart 字节，仍检查后续 SOF，防止第二帧绕过尺寸预算。
      while (offset < data.length) {
        if (data[offset++] !== 0xff) continue;
        const start = offset - 1;
        while (data[offset] === 0xff) offset++;
        if (data[offset] === 0x00 || (data[offset] >= 0xd0 && data[offset] <= 0xd7)) { offset++; continue; }
        offset = start; break;
      }
    }
  }
  return undefined;
}
