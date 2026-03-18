import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

const architectureModelPath = path.join(
  repoRoot,
  "tools",
  "architecture-model.v1.json",
);

function readDoc(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("architecture model", () => {
  it("freezes the compatibility vocabularies in one machine-readable file", () => {
    const doc = JSON.parse(fs.readFileSync(architectureModelPath, "utf8")) as {
      version: number;
      serverCapabilityFamilies: string[];
      browserCapabilityFamilies: string[];
      packageClasses: string[];
      browserCapabilityStates: string[];
      browserFeatureStates: string[];
      browserPermissionStates: string[];
      portableCommonIsolationFloor: string[];
      evidenceStatuses: string[];
    };

    expect(doc.version).toBe(1);
    expect(doc.serverCapabilityFamilies).toEqual([
      "storage",
      "network",
      "environment",
      "process",
      "handles",
    ]);
    expect(doc.browserCapabilityFamilies).toEqual([
      "storage",
      "network",
      "fileAccess",
      "worker",
      "handles",
    ]);
    expect(doc.packageClasses).toEqual([
      "base_interpreter",
      "pure_python",
      "native_platform",
      "project_overlay",
    ]);
    expect(doc.browserCapabilityStates).toEqual([
      "available_granted",
      "available_denied",
      "unavailable",
      "hard_limit",
    ]);
    expect(doc.browserFeatureStates).toEqual([
      "available",
      "unavailable",
      "hard_limit",
    ]);
    expect(doc.browserPermissionStates).toEqual([
      "granted",
      "denied",
      "not_requested",
      "not_applicable",
    ]);
    expect(doc.portableCommonIsolationFloor).toEqual([
      "process_boundary",
      "immutable_runtime_image",
      "projected_roots",
      "guest_temp_root",
      "environment_allowlist",
      "resource_ceilings",
      "brokered_capabilities",
      "audit_trail",
      "artifact_integrity",
    ]);
    expect(doc.evidenceStatuses).toEqual([
      "supported",
      "unsupported",
      "prototype",
      "not_proven",
    ]);
  });

  it("keeps contributor-facing docs aligned with the frozen vocabulary", () => {
    const architecture = readDoc("docs/architecture.md");
    const runtimeApi = readDoc("docs/reference/runtime-api.md");
    const supportMatrix = readDoc("docs/support-matrix.md");
    const profiles = readDoc("docs/reference/profiles.md");

    expect(architecture).toContain("portable common isolation floor");
    expect(architecture).toContain("OS-specific strengthening claims");
    expect(architecture).toContain("server bundled compatibility runtime");
    expect(architecture).toContain("browser native capability runtime");

    expect(runtimeApi).toContain("current implementation truth");
    expect(runtimeApi).toContain("capability families");
    expect(runtimeApi).toContain("capabilityFamilies");
    expect(runtimeApi).toContain("available_granted");

    expect(supportMatrix).toContain("portable common isolation floor");
    expect(supportMatrix).toContain("package classes");
    expect(supportMatrix).toContain("matrix-backed");
    expect(supportMatrix).toContain("Current Browser Capability States");
    expect(supportMatrix).toContain("unavailable");

    expect(profiles).toContain("portable common isolation floor");
    expect(profiles).toContain("OS-specific strengthening");
    expect(profiles).toContain("available_denied");
  });
});
