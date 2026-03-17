import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const releaseRehearsalModulePath = "../../../scripts/release-rehearsal.mjs";
const { buildReleaseRehearsalRecord, defaultReleaseRehearsalSubjects } =
  (await import(releaseRehearsalModulePath)) as {
    buildReleaseRehearsalRecord(input: {
      version: string;
      tagName: string;
      sourceArchive: { path: string; sha256: string };
      releaseNotes: { path: string; sha256: string };
      sbom: { path: string; sha256: string };
      supplyChainAttestation: { path: string; sha256: string };
      provenanceVerification: {
        ok: boolean | null;
        skipped: boolean;
        bundlePath: string | null;
        signerWorkflow: string | null;
        subjects: string[];
      };
    }): {
      publishSkipped: boolean;
      version: string;
      tagName: string;
      sourceArchive: { path: string; sha256: string };
      releaseNotes: { path: string; sha256: string };
      sbom: { path: string; sha256: string };
      provenanceVerification: { ok: boolean | null };
    };
    defaultReleaseRehearsalSubjects: string[];
  };

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/release-rehearsal.yml", import.meta.url),
);

describe("release rehearsal", () => {
  it("tracks non-publishing release evidence with digests", () => {
    const record = buildReleaseRehearsalRecord({
      version: "0.0.0",
      tagName: "v0.0.0",
      sourceArchive: {
        path: "dist/aegispy-source.tar.gz",
        sha256: "a".repeat(64),
      },
      releaseNotes: {
        path: "dist/release-notes.md",
        sha256: "b".repeat(64),
      },
      sbom: {
        path: "artifacts/security/supply-chain-sbom.json",
        sha256: "c".repeat(64),
      },
      supplyChainAttestation: {
        path: "artifacts/security/supply-chain-attestation.json",
        sha256: "d".repeat(64),
      },
      provenanceVerification: {
        ok: null,
        skipped: true,
        bundlePath: null,
        signerWorkflow: null,
        subjects: defaultReleaseRehearsalSubjects,
      },
    });

    expect(record.publishSkipped).toBe(true);
    expect(record.version).toBe("0.0.0");
    expect(record.tagName).toBe("v0.0.0");
    expect(record.sourceArchive.path).toBe("dist/aegispy-source.tar.gz");
    expect(record.releaseNotes.path).toBe("dist/release-notes.md");
    expect(record.sbom.path).toBe("artifacts/security/supply-chain-sbom.json");
    expect(record.provenanceVerification.ok).toBeNull();
  });

  it("keeps source archive in the provenance subject set", () => {
    expect(defaultReleaseRehearsalSubjects).toEqual([
      "dist/aegispy-source.tar.gz",
      "artifacts/engine/cpython-wasi.wasm",
      "artifacts/engine/aegispy-capability-bridge.py",
      "artifacts/component/aegispy.component.wasm",
    ]);
  });

  it("keeps the workflow manual and non-publishing", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("gh release create");
  });
});
