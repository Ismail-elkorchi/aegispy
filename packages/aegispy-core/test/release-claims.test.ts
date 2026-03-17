import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const releaseRehearsalModulePath = "../../../scripts/release-rehearsal.mjs";
const { defaultReleaseRehearsalSubjects } = (await import(
  releaseRehearsalModulePath
)) as {
  defaultReleaseRehearsalSubjects: string[];
};

const releaseClaimsModulePath = "../../../scripts/release_claims_check.mjs";
const { readReleaseRehearsal, validateReleaseRehearsalArtifact } =
  (await import(releaseClaimsModulePath)) as {
    readReleaseRehearsal(
      relPath: string,
      options?: { repoRoot?: string },
    ): {
      ok: boolean;
      present: boolean;
      failures: Array<{ error: string; field?: string }>;
    };
    validateReleaseRehearsalArtifact(
      document: unknown,
      options?: { repoRoot?: string },
    ): {
      ok: boolean;
      present: true;
      failures: Array<{ error: string; field?: string }>;
    };
  };

function writeFile(repoRoot: string, relPath: string, contents: string) {
  const fullPath = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents, "utf8");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const tempRoot = tempRoots.pop();
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

describe("release claims", () => {
  it("accepts a finalized rehearsal artifact with matching digests", () => {
    const repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "aegispy-release-claims-"),
    );
    tempRoots.push(repoRoot);

    writeFile(repoRoot, "dist/aegispy-source.tar.gz", "source-archive");
    writeFile(repoRoot, "dist/release-notes.md", "release-notes");
    writeFile(repoRoot, "artifacts/security/supply-chain-sbom.json", "{}\n");
    writeFile(
      repoRoot,
      "artifacts/security/supply-chain-attestation.json",
      '{"ok":true}\n',
    );

    const result = validateReleaseRehearsalArtifact(
      {
        ok: true,
        version: "0.0.0",
        tagName: "v0.0.0",
        publishSkipped: true,
        sourceArchive: {
          path: "dist/aegispy-source.tar.gz",
          sha256: sha256("source-archive"),
        },
        releaseNotes: {
          path: "dist/release-notes.md",
          sha256: sha256("release-notes"),
        },
        sbom: {
          path: "artifacts/security/supply-chain-sbom.json",
          sha256: sha256("{}\n"),
        },
        supplyChainAttestation: {
          path: "artifacts/security/supply-chain-attestation.json",
          sha256: sha256('{"ok":true}\n'),
        },
        provenanceVerification: {
          ok: true,
          skipped: false,
          bundlePath: "artifacts/security/provenance-bundle.jsonl",
          signerWorkflow:
            "Ismail-elkorchi/aegispy/.github/workflows/release-rehearsal.yml",
          subjects: defaultReleaseRehearsalSubjects,
        },
      },
      { repoRoot },
    );

    expect(result).toEqual({
      ok: true,
      present: true,
      failures: [],
    });
  });

  it("treats a missing rehearsal artifact as optional", () => {
    const repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "aegispy-release-claims-"),
    );
    tempRoots.push(repoRoot);

    expect(
      readReleaseRehearsal("artifacts/security/release-rehearsal.json", {
        repoRoot,
      }),
    ).toEqual({
      ok: true,
      present: false,
      failures: [],
    });
  });
});
