import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeBrowserWorkerRequest } from "../src/runtime/browser-worker-request";
import { writeArtifact } from "./helpers/artifact";

const invariants = ["INV-FEAT-0026", "INV-SECU-0008"];

function validWorkerRequest() {
  return {
    requestId: "req-1",
    code: 'print("browser-worker")',
    stdinUtf8: "",
    determinism: {
      enabled: true,
      epochMs: 123,
      rngSeedHex: "1234abcd",
    },
    assetBaseUrl: "https://cdn.example.test/pyodide",
    packages: ["micropip"],
  };
}

describe("browser worker request", () => {
  it("normalizes valid browser worker requests", () => {
    const result = normalizeBrowserWorkerRequest(validWorkerRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected normalized browser worker request");
    }
    expect(result.value.requestId).toBe("req-1");
    expect(result.value.packages).toEqual(["micropip"]);
  });

  it("keeps browser worker input validation stable across fuzzed payloads", () => {
    let validCases = 0;
    let invalidCases = 0;
    let packageCases = 0;
    let assetBaseUrlCases = 0;
    let invalidPackageCases = 0;
    let invalidAssetBaseUrlCases = 0;

    const validRequestArb = fc.record({
      requestId: fc.string({ minLength: 1, maxLength: 12 }),
      code: fc.string({ minLength: 1, maxLength: 64 }),
      stdinUtf8: fc.string({ maxLength: 32 }),
      determinism: fc.record({
        enabled: fc.boolean(),
        epochMs: fc.integer({ min: 0, max: 10_000 }),
        rngSeedHex: fc.stringMatching(/^[0-9a-f]{8}$/u),
      }),
      assetBaseUrl: fc.option(fc.webUrl(), { nil: undefined }),
      packages: fc.array(fc.constantFrom("micropip", "packaging", "jinja2"), {
        maxLength: 3,
      }),
    });
    const invalidRequestArb = fc.oneof(
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 12 }),
        code: fc.string({ minLength: 1, maxLength: 64 }),
        stdinUtf8: fc.string({ maxLength: 32 }),
        determinism: fc.record({
          enabled: fc.boolean(),
          epochMs: fc.integer({ min: 0, max: 10_000 }),
          rngSeedHex: fc.stringMatching(/^[0-9a-f]{8}$/u),
        }),
        assetBaseUrl: fc.integer(),
        packages: fc.array(fc.constantFrom("micropip", "packaging"), {
          maxLength: 3,
        }),
      }),
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 12 }),
        code: fc.string({ minLength: 1, maxLength: 64 }),
        stdinUtf8: fc.string({ maxLength: 32 }),
        determinism: fc.record({
          enabled: fc.boolean(),
          epochMs: fc.integer({ min: 0, max: 10_000 }),
          rngSeedHex: fc.stringMatching(/^[0-9a-f]{8}$/u),
        }),
        assetBaseUrl: fc.option(fc.webUrl(), { nil: undefined }),
        packages: fc.array(fc.integer(), { minLength: 1, maxLength: 3 }),
      }),
    );

    fc.assert(
      fc.property(
        fc.oneof(validRequestArb, invalidRequestArb, fc.jsonValue()),
        (input) => {
          const result = normalizeBrowserWorkerRequest(input);
          if (result.ok) {
            validCases += 1;
            expect(result.value.requestId.length).toBeGreaterThan(0);
            if (result.value.packages.length > 0) {
              packageCases += 1;
            }
            if (result.value.assetBaseUrl !== undefined) {
              assetBaseUrlCases += 1;
            }
          } else {
            invalidCases += 1;
            expect(result.issues.length).toBeGreaterThan(0);
            if (result.issues.includes("packages:string_array_expected")) {
              invalidPackageCases += 1;
            }
            if (result.issues.includes("assetBaseUrl:string_expected")) {
              invalidAssetBaseUrlCases += 1;
            }
          }
        },
      ),
      { numRuns: 180 },
    );

    expect(validCases).toBeGreaterThan(0);
    expect(invalidCases).toBeGreaterThan(0);
    expect(packageCases).toBeGreaterThan(0);
    expect(assetBaseUrlCases).toBeGreaterThan(0);
    expect(invalidPackageCases).toBeGreaterThan(0);
    expect(invalidAssetBaseUrlCases).toBeGreaterThan(0);

    writeArtifact("artifacts/security/browser-input-fuzz.json", {
      ok: true,
      invariants,
      runs: 180,
      validCases,
      invalidCases,
      packageCases,
      assetBaseUrlCases,
      invalidPackageCases,
      invalidAssetBaseUrlCases,
    });
  });
});
