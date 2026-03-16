import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeFrames,
  decodeJsonFrame,
  encodeFrame,
  encodeJsonFrame,
} from "../src/protocol/framing";
import { writeArtifact } from "./helpers/artifact";

const invariants = ["INV-ARCH-0003"];
const frameDecodeSeed = 0x5eed1001;
const jsonDecodeSeed = 0x5eed1002;
const frameDecodeIterations = 120;
const jsonDecodeIterations = 120;

describe("protocol framing", () => {
  it("encodes and decodes length-prefixed json", () => {
    const messageA = {
      type: "run",
      requestId: "one",
      run: { code: 'print("x")' },
    };
    const messageB = {
      type: "run_result",
      requestId: "one",
      result: { status: "ok" },
    };

    const encodedA = encodeJsonFrame(messageA);
    const encodedB = encodeJsonFrame(messageB);
    const joined = Buffer.concat([encodedA, encodedB]);

    const decoded = decodeFrames(joined);
    expect(decoded.frames).toHaveLength(2);

    const parsedA = decodeJsonFrame(decoded.frames[0]);
    const parsedB = decodeJsonFrame(decoded.frames[1]);

    expect(parsedA).toEqual(messageA);
    expect(parsedB).toEqual(messageB);

    writeArtifact("artifacts/tests/protocol-framing.json", {
      ok: true,
      invariants,
      frameLengths: [encodedA.length, encodedB.length],
    });
  });

  it("round-trips arbitrary framed payload batches", () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ maxLength: 128 }), {
          maxLength: 12,
        }),
        fc.uint8Array({ maxLength: 3 }),
        (payloads, trailing) => {
          const batch = Buffer.concat([
            ...payloads.map((payload) => encodeFrame(payload)),
            Buffer.from(trailing),
          ]);

          const decoded = decodeFrames(batch);

          expect(decoded.frames.map((frame) => Buffer.from(frame))).toEqual(
            payloads.map((payload) => Buffer.from(payload)),
          );
          expect(Buffer.from(decoded.remaining)).toEqual(Buffer.from(trailing));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("round-trips arbitrary json values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const encoded = encodeJsonFrame(value);
        const decoded = decodeFrames(encoded);
        const expected = JSON.parse(JSON.stringify(value)) as unknown;

        expect(decoded.frames).toHaveLength(1);
        expect(decoded.remaining).toHaveLength(0);
        expect(decodeJsonFrame(decoded.frames[0])).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("keeps frame decoding stable across fuzzed malformed payloads", async () => {
    let frameRuns = 0;
    let jsonRuns = 0;
    let decodedFrames = 0;
    let trailingBytes = 0;
    let parsedJsonCases = 0;
    let jsonParseFailures = 0;

    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (payload) => {
        frameRuns += 1;
        const decoded = decodeFrames(Buffer.from(payload));
        decodedFrames += decoded.frames.length;
        trailingBytes += decoded.remaining.length;

        expect(Array.isArray(decoded.frames)).toBe(true);
        expect(decoded.remaining.length).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: frameDecodeIterations, seed: frameDecodeSeed },
    );

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc
            .jsonValue()
            .map((value) => Buffer.from(JSON.stringify(value), "utf8")),
          fc
            .uint8Array({ minLength: 1, maxLength: 128 })
            .map((value) => Buffer.from(value)),
        ),
        async (payload) => {
          jsonRuns += 1;
          const decoded = decodeFrames(encodeFrame(payload));
          expect(decoded.frames).toHaveLength(1);
          expect(decoded.remaining).toHaveLength(0);
          const parseResult = await Promise.resolve()
            .then(() => decodeJsonFrame(decoded.frames[0]))
            .then(
              () => ({ ok: true }),
              () => ({ ok: false }),
            );
          if (parseResult.ok) {
            parsedJsonCases += 1;
          } else {
            jsonParseFailures += 1;
          }
        },
      ),
      { numRuns: jsonDecodeIterations, seed: jsonDecodeSeed },
    );

    expect(parsedJsonCases).toBeGreaterThan(0);
    expect(jsonParseFailures).toBeGreaterThan(0);

    writeArtifact("artifacts/security/protocol-framing-fuzz.json", {
      ok: true,
      invariants: ["INV-ARCH-0003", "INV-SECU-0011"],
      seedHex: `${frameDecodeSeed.toString(16)}${jsonDecodeSeed.toString(16)}`,
      iterations: frameRuns + jsonRuns,
      runs: frameRuns + jsonRuns,
      categories: {
        frameDecodeIterations: frameRuns,
        jsonDecodeIterations: jsonRuns,
      },
      decodedFrames,
      trailingBytes,
      parsedJsonCases,
      jsonParseFailures,
    });
  });
});
