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
});
