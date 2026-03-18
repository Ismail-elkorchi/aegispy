import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("portable isolation floor", () => {
  it("keeps contributor-facing docs and checks aligned with the portable floor artifacts", () => {
    const runtimeApi = read("docs/reference/runtime-api.md");
    const supportMatrix = read("docs/support-matrix.md");
    const profiles = read("docs/reference/profiles.md");
    const topLevelCheck = read("scripts/check");
    const portableCheck = read("package.json");
    const workflow = read(".github/workflows/ci.yml");
    const floorCheck = read("scripts/portable_isolation_floor_check.mjs");
    const floorSmoke = read("scripts/portable_isolation_floor_smoke.mjs");

    expect(runtimeApi).toContain("portableIsolationFloorVersion");
    expect(runtimeApi).toContain("hostStrengthening");
    expect(supportMatrix).toContain("portable common isolation floor");
    expect(supportMatrix).toContain("OS-specific strengthening");
    expect(profiles).toContain("portable common isolation floor");
    expect(profiles).toContain("OS-specific strengthening");

    expect(topLevelCheck).toContain(
      "bash scripts/portable_isolation_floor_check",
    );
    expect(portableCheck).toContain("portable_isolation_floor_smoke");
    expect(workflow).toContain("portable_isolation_floor_smoke");
    expect(workflow).toContain("Portable Floor Prototype");
    expect(floorCheck).toContain("portable-isolation-floor");
    expect(floorSmoke).toContain("portable-isolation-floor");
  });
});
