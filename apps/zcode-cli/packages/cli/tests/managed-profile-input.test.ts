import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";
import { readManagedPrompt } from "../src/managed-profile-input.js";

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}

function png(width = 1, height = 1): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), pngChunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const image = {mediaType: "image/png", data: png()};
const frame = {version: 2, text: "describe this", images: [image]};
const enabled = {supportsImage: true};
// Deterministic 1x1 red JPEG encoded by the repository's existing Jimp adapter dependency.
const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAEAAQMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APxfr/Kc/wC/g//Z";
function stream(value: unknown): PassThrough {
  const input = new PassThrough(); input.end(`${JSON.stringify(value)}\n`); return input;
}

test("managed prompt keeps legacy strings and v2 uses original inline image attachments", async () => {
  assert.equal(await readManagedPrompt(stream({text: "old\nprompt"})), "old\nprompt");
  const input = new PassThrough();
  const pending = readManagedPrompt(input, enabled);
  const encoded = JSON.stringify(frame);
  input.write(encoded.slice(0, 63)); input.end(encoded.slice(63) + '\n{"id":7}\n');
  assert.deepEqual(await pending, {text: frame.text, attachments: [{type: "image",
    content: `data:image/png;base64,${image.data}`, mimeType: "image/png",
    sizeBytes: Buffer.from(image.data, "base64").length}]});
  assert.equal(input.read()?.toString(), '{"id":7}\n');
});

test("managed v2 requires an explicit frozen image capability", async () => {
  for (const profile of [undefined, {}, {supportsImage: false}]) {
    await assert.rejects(readManagedPrompt(stream(frame), profile), /image input is not enabled/);
  }
});

test("managed prompt validates real JPEG decoding and rejects later oversized frames", async () => {
  const result = await readManagedPrompt(stream({...frame, images: [{mediaType: "image/jpeg", data: jpeg}]}), enabled);
  assert.equal(typeof result, "object");
  assert.equal(typeof result === "string" ? undefined : result.attachments?.[0]?.content, `data:image/jpeg;base64,${jpeg}`);
  const bytes = Buffer.from(jpeg, "base64");
  const oversized = Buffer.from(bytes);
  const sof = oversized.indexOf(Buffer.from([0xff, 0xc0]));
  oversized.writeUInt16BE(8193, sof + 7);
  const secondFrame = Buffer.concat([bytes.subarray(0, -2), oversized.subarray(sof, sof + 19), bytes.subarray(-2)]);
  for (const data of [oversized, secondFrame]) {
    await assert.rejects(readManagedPrompt(stream({...frame, images: [{mediaType: "image/jpeg", data: data.toString("base64")}]}), enabled), /Managed prompt/);
  }
});

test("managed prompt rejects invalid shape, URLs, paths, encodings and MIME spoofing", async () => {
  for (const value of [
    {...frame, version: 3}, {...frame, text: " "}, {...frame, images: []},
    {...frame, images: Array(5).fill(image)}, {...frame, path: "/private/file"},
    {...frame, images: [{...image, path: "/etc/passwd"}]},
    {...frame, images: [{...image, data: "https://outside.invalid/image.png"}]},
    {...frame, images: [{...image, data: `data:image/png;base64,${image.data}`}]},
    {...frame, images: [{...image, data: image.data + "\n"}]},
    {...frame, images: [{...image, mediaType: "image/jpeg"}]},
    {...frame, images: [{...image, mediaType: "image/webp"}]},
    {...frame, images: [{...image, data: Buffer.from("not an image").toString("base64")}]},
  ]) await assert.rejects(readManagedPrompt(stream(value), enabled), /^Error: Managed prompt frame is invalid$/);
});

test("managed prompt rejects damaged images, allocation bombs and bounded input", async () => {
  const damaged = Buffer.from(image.data, "base64"); damaged[damaged.length - 1] ^= 1;
  for (const data of [damaged.toString("base64"), png(100000, 100000), png(8193, 1), png(5000, 5000)]) {
    await assert.rejects(readManagedPrompt(stream({...frame, images: [{...image, data}]}), enabled), /Managed prompt/);
  }
  await assert.rejects(readManagedPrompt(stream({...frame, images: Array(3).fill({...image, data: png(4000, 4000)})}), enabled), /Managed prompt/);
  const tooManyBytes = {...image, data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64")};
  await assert.rejects(readManagedPrompt(stream({...frame, images: [tooManyBytes]}), enabled), /Managed prompt/);
  const huge = new PassThrough(); huge.end("x".repeat(6 * 1024 * 1024 + 1));
  await assert.rejects(readManagedPrompt(huge, enabled), /too large/);
});
