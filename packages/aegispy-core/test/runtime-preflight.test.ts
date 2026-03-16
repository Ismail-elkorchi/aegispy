import { describe, expect, it } from "vitest";
import type { RunRequest, RuntimeCapabilities } from "../src/index";
import { preflightRuntimeRequest } from "../src/runtime/preflight";

function makeRequest(): RunRequest {
  return {
    host: "browser",
    code: 'print("browser")',
    argv: ["python"],
    stdinUtf8: "",
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    limits: {
      time: {
        wallMs: 100,
        cpuMs: 100,
      },
      bytes: {
        memoryBytes: 1024,
        stdoutBytes: 1024,
        stderrBytes: 1024,
      },
    },
    determinism: {
      enabled: true,
      epochMs: 5,
      rngSeedHex: "abcd",
    },
  };
}

function makeBrowserCapabilities(): RuntimeCapabilities {
  return {
    host: "browser",
    profile: "browser-real-engine",
    transport: "worker",
    capabilityChannel: "worker-timeout",
    fs: false,
    http: false,
    env: false,
    deterministic: true,
    hardened: false,
  };
}

describe("runtime preflight", () => {
  it("rejects unsupported capability grants with stable audit ordering", () => {
    const outcome = preflightRuntimeRequest(
      {
        runtimeHost: "browser",
        capabilities: makeBrowserCapabilities(),
        closed: false,
      },
      {
        ...makeRequest(),
        permissions: {
          fs: null,
          http: {
            allowOrigins: ["https://example.com"],
            denyOrigins: [],
            maxRequests: 1,
            maxBytes: 256,
          },
          env: null,
        },
      },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected unsupported capability denial");
    }

    expect(outcome.result.status).toBe("error");
    if (outcome.result.status !== "error") {
      throw new Error("expected error result");
    }

    expect(outcome.result.error.code).toBe("AEG-UNSUPPORTED-HOST");
    expect(outcome.result.meta.termination).toBe("policy_denied");
    expect(outcome.result.meta.audit).toHaveLength(3);
    expect(outcome.result.meta.audit[0]?.kind).toBe("runtime_channel");
    expect(outcome.result.meta.audit[0]?.detailJson).toBe(
      "capability_channel:worker-timeout",
    );
    expect(outcome.result.meta.audit[1]?.kind).toBe("runtime_binding");
    expect(outcome.result.meta.audit[2]?.kind).toBe("policy_denied");
    expect(
      JSON.parse(outcome.result.meta.audit[2]?.detailJson ?? "{}"),
    ).toMatchObject({
      reason: "host_profile_capability_unsupported",
      unsupportedCapabilities: ["http"],
      profile: "browser-real-engine",
    });
  });
});
