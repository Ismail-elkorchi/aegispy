import { describe, expect, it } from "vitest";
import {
  validateRunRequest,
  validateRunResult,
} from "../src/contracts/validation";
import { writeArtifact } from "./helpers/artifact";

const invariants = ["INV-FEAT-0002"];

describe("contract validation", () => {
  it("rejects invalid run request and invalid run result", () => {
    const invalidRequest = {
      host: "node",
      code: "print(1)",
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: -1,
          cpuMs: 100,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 0,
        rngSeedHex: "zz",
      },
    };

    const requestResult = validateRunRequest(invalidRequest);
    expect(requestResult.ok).toBe(false);

    const invalidRunResult = {
      status: "error",
      exitCode: 1,
      stdoutUtf8: "",
      stderrUtf8: "",
      meta: {
        startedTsMs: 0,
        endedTsMs: 1,
        durationMs: 1,
        cpuMs: 1,
        memoryPeakBytes: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        termination: "policy_denied",
        audit: [],
      },
      error: {
        message: "x",
        detailJson: "{}",
      },
    };

    const runResult = validateRunResult(invalidRunResult);
    expect(runResult.ok).toBe(false);

    writeArtifact("artifacts/tests/contract-validation.json", {
      ok: true,
      invariants,
      requestIssues: requestResult.ok ? [] : requestResult.issues,
      resultIssues: runResult.ok ? [] : runResult.issues,
    });
  });
});
