import { describe, expect, it } from "vitest";
import {
  type DependencyKind,
  enforcesNativeRegistry,
  resolveLockfile,
  verifyLockfile,
  type DependencyInput,
  type Lockfile,
  type LockfileEntry,
  type RegistryConfig,
  type ResolveLockfileInput,
} from "../src/index";
import { writeArtifact } from "./helpers/artifact";

const invariants = ["INV-FEAT-0016", "INV-FEAT-0023"];

type Coverage = [
  DependencyKind,
  DependencyInput,
  Lockfile,
  LockfileEntry,
  RegistryConfig,
  ResolveLockfileInput,
];
const coverage: Coverage | null = null;
void coverage;

describe("packaging", () => {
  it("resolves lockfile with hashes and registry policy", () => {
    const lockfile = resolveLockfile({
      dependencies: [
        {
          name: "requests",
          version: "2.31.0",
          kind: "pure_python",
        },
        {
          name: "numpy",
          version: "2.0.0",
          kind: "native_wasm",
        },
      ],
      registries: {
        pythonIndex: "https://pypi.org/simple",
        nativeIndex: "https://registry.aegispy.dev/wasm",
      },
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    const verified = verifyLockfile(lockfile);
    const nativePolicy = enforcesNativeRegistry(
      lockfile,
      "https://registry.aegispy.dev/wasm",
    );

    expect(verified.ok).toBe(true);
    expect(nativePolicy.ok).toBe(true);

    writeArtifact("artifacts/tests/packaging-lockfile.json", {
      ok: true,
      invariants: ["INV-FEAT-0016"],
      lockfile,
      verified,
    });

    writeArtifact("artifacts/tests/packaging-registry-policy.json", {
      ok: true,
      invariants: ["INV-FEAT-0023"],
      policy: nativePolicy,
    });

    writeArtifact("artifacts/tests/packaging-summary.json", {
      ok: true,
      invariants,
      entryCount: lockfile.entries.length,
    });
  });
});
