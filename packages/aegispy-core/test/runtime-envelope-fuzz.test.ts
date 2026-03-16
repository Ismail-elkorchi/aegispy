import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  validateRunRequest,
  type ValidationResult,
} from "../src/contracts/validation";
import type {
  HostKind,
  RunRequest,
  RuntimeCapabilities,
} from "../src/contracts/types";
import { preflightRuntimeRequest } from "../src/runtime/preflight";
import { writeArtifact } from "./helpers/artifact";

const invariants = ["INV-FEAT-0027", "INV-SECU-0009"];
const runtimeEnvelopeFuzzSeed = 0x5eed4001;
const runtimeEnvelopeFuzzIterations = 180;

function runtimeCapabilities(host: HostKind): RuntimeCapabilities {
  return {
    host,
    profile: host === "browser" ? "browser-real-engine" : "server-hardened",
    transport: host === "browser" ? "worker" : "process",
    capabilityChannel: host === "browser" ? "worker-timeout" : "component-wit",
    fs: host !== "browser",
    http: host !== "browser",
    env: host !== "browser",
    deterministic: true,
    hardened: host !== "browser",
  };
}

describe("runtime envelope fuzz", () => {
  it("keeps capability-envelope validation and preflight stable across fuzzed inputs", () => {
    let validCases = 0;
    let invalidCases = 0;
    let preflightOkCases = 0;
    let preflightDeniedCases = 0;
    let browserDeniedCases = 0;

    const validRequestArb = fc.record({
      host: fc.constantFrom("node", "deno", "bun", "browser"),
      code: fc.string({ minLength: 1, maxLength: 80 }),
      argv: fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
        minLength: 1,
        maxLength: 3,
      }),
      stdinUtf8: fc.string({ maxLength: 32 }),
      permissions: fc.record({
        fs: fc.option(
          fc.record({
            readRoots: fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
              maxLength: 2,
            }),
            writeRoots: fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
              maxLength: 2,
            }),
            maxBytes: fc.integer({ min: 0, max: 4096 }),
            maxFiles: fc.integer({ min: 0, max: 8 }),
          }),
          { nil: null },
        ),
        http: fc.option(
          fc.record({
            allowOrigins: fc.array(fc.webUrl(), { maxLength: 2 }),
            denyOrigins: fc.array(fc.webUrl(), { maxLength: 2 }),
            maxRequests: fc.integer({ min: 0, max: 16 }),
            maxBytes: fc.integer({ min: 0, max: 4096 }),
          }),
          { nil: null },
        ),
        env: fc.option(
          fc.record({
            allowKeys: fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
              maxLength: 4,
            }),
          }),
          { nil: null },
        ),
      }),
      limits: fc.record({
        time: fc.record({
          wallMs: fc.integer({ min: 1, max: 20_000 }),
          cpuMs: fc.integer({ min: 1, max: 20_000 }),
        }),
        bytes: fc.record({
          memoryBytes: fc.integer({ min: 1, max: 1_000_000 }),
          stdoutBytes: fc.integer({ min: 1, max: 64_000 }),
          stderrBytes: fc.integer({ min: 1, max: 64_000 }),
        }),
      }),
      determinism: fc.record({
        enabled: fc.boolean(),
        epochMs: fc.integer({ min: 0, max: 1_000_000 }),
        rngSeedHex: fc.stringMatching(/^[0-9a-f]{8}$/u),
      }),
    });
    const browserCapabilityRequestArb = fc.record({
      host: fc.constant("browser"),
      code: fc.string({ minLength: 1, maxLength: 80 }),
      argv: fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
        minLength: 1,
        maxLength: 3,
      }),
      stdinUtf8: fc.string({ maxLength: 32 }),
      permissions: fc.oneof(
        fc.record({
          fs: fc.record({
            readRoots: fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
              minLength: 1,
              maxLength: 2,
            }),
            writeRoots: fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
              maxLength: 2,
            }),
            maxBytes: fc.integer({ min: 0, max: 4096 }),
            maxFiles: fc.integer({ min: 0, max: 8 }),
          }),
          http: fc.constant(null),
          env: fc.constant(null),
        }),
        fc.record({
          fs: fc.constant(null),
          http: fc.record({
            allowOrigins: fc.array(fc.webUrl(), { minLength: 1, maxLength: 2 }),
            denyOrigins: fc.array(fc.webUrl(), { maxLength: 2 }),
            maxRequests: fc.integer({ min: 0, max: 16 }),
            maxBytes: fc.integer({ min: 0, max: 4096 }),
          }),
          env: fc.constant(null),
        }),
        fc.record({
          fs: fc.constant(null),
          http: fc.constant(null),
          env: fc.record({
            allowKeys: fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
              minLength: 1,
              maxLength: 4,
            }),
          }),
        }),
      ),
      limits: fc.record({
        time: fc.record({
          wallMs: fc.integer({ min: 1, max: 20_000 }),
          cpuMs: fc.integer({ min: 1, max: 20_000 }),
        }),
        bytes: fc.record({
          memoryBytes: fc.integer({ min: 1, max: 1_000_000 }),
          stdoutBytes: fc.integer({ min: 1, max: 64_000 }),
          stderrBytes: fc.integer({ min: 1, max: 64_000 }),
        }),
      }),
      determinism: fc.record({
        enabled: fc.boolean(),
        epochMs: fc.integer({ min: 0, max: 1_000_000 }),
        rngSeedHex: fc.stringMatching(/^[0-9a-f]{8}$/u),
      }),
    });

    fc.assert(
      fc.property(
        fc.oneof(validRequestArb, browserCapabilityRequestArb, fc.jsonValue()),
        (input) => {
          const validation = validateRunRequest(
            input,
          ) as ValidationResult<RunRequest>;
          if (validation.ok) {
            validCases += 1;
            const preflight = preflightRuntimeRequest(
              {
                runtimeHost: validation.value.host,
                capabilities: runtimeCapabilities(validation.value.host),
                closed: false,
              },
              input,
            );
            if (preflight.ok) {
              preflightOkCases += 1;
            } else {
              preflightDeniedCases += 1;
              expect(preflight.result.status).toBe("error");
              if (preflight.result.status !== "error") {
                throw new Error("expected denied preflight result");
              }
              expect(preflight.result.error.code).toBe("AEG-UNSUPPORTED-HOST");
              expect(preflight.result.meta.termination).toBe("policy_denied");
              expect(validation.value.host).toBe("browser");
              browserDeniedCases += 1;
            }
          } else {
            invalidCases += 1;
            expect(validation.issues.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: runtimeEnvelopeFuzzIterations, seed: runtimeEnvelopeFuzzSeed },
    );

    expect(validCases).toBeGreaterThan(0);
    expect(invalidCases).toBeGreaterThan(0);
    expect(preflightOkCases).toBeGreaterThan(0);
    expect(preflightDeniedCases).toBeGreaterThan(0);
    expect(browserDeniedCases).toBeGreaterThan(0);

    writeArtifact("artifacts/security/runtime-envelope-fuzz.json", {
      ok: true,
      invariants,
      seedHex: runtimeEnvelopeFuzzSeed.toString(16),
      iterations: runtimeEnvelopeFuzzIterations,
      runs: runtimeEnvelopeFuzzIterations,
      categories: {
        validInputs: validCases,
        invalidInputs: invalidCases,
        preflightOkInputs: preflightOkCases,
        preflightDeniedInputs: preflightDeniedCases,
        browserDeniedInputs: browserDeniedCases,
      },
      validCases,
      invalidCases,
      preflightOkCases,
      preflightDeniedCases,
      browserDeniedCases,
    });
  });
});
