import { Buffer } from "node:buffer";

import { SERVER_ENGINE_PROTOCOL_MAX_FRAME_BYTES } from "./messages";

export function encodeFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength > SERVER_ENGINE_PROTOCOL_MAX_FRAME_BYTES) {
    throw new Error("frame_too_large");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, Buffer.from(payload)]);
}

export function encodeJsonFrame(value: unknown): Buffer {
  const json = JSON.stringify(value);
  return encodeFrame(Buffer.from(json, "utf8"));
}

export interface DecodedBatch {
  frames: Uint8Array[];
  remaining: Buffer;
  error?: "frame_too_large";
}

export interface DecodeFrameOptions {
  maxFrameBytes?: number;
  throwOnOversized?: boolean;
}

export function decodeFrames(
  input: Uint8Array,
  options: DecodeFrameOptions = {},
): DecodedBatch {
  const buffer = Buffer.from(input);
  const frames: Uint8Array[] = [];
  let offset = 0;
  const maxFrameBytes =
    options.maxFrameBytes ?? SERVER_ENGINE_PROTOCOL_MAX_FRAME_BYTES;

  while (offset + 4 <= buffer.length) {
    const frameLength = buffer.readUInt32BE(offset);
    if (frameLength > maxFrameBytes) {
      if (options.throwOnOversized === true) {
        throw new Error("frame_too_large");
      }
      return {
        frames,
        remaining: buffer.subarray(offset),
        error: "frame_too_large",
      };
    }
    if (offset + 4 + frameLength > buffer.length) break;
    const start = offset + 4;
    const end = start + frameLength;
    frames.push(buffer.subarray(start, end));
    offset = end;
  }

  return {
    frames,
    remaining: buffer.subarray(offset),
  };
}

export function decodeJsonFrame(frame: Uint8Array): unknown {
  const text = Buffer.from(frame).toString("utf8");
  return JSON.parse(text) as unknown;
}
