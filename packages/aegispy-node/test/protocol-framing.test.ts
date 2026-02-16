import { describe, expect, it } from "vitest";
import {
  decodeFrames,
  decodeJsonFrame,
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
});
