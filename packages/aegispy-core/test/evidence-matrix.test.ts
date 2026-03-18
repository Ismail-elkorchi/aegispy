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

describe("evidence matrices", () => {
  it("freezes the generated server and browser claim skeleton in one source file", () => {
    const doc = JSON.parse(read("tools/evidence-matrix.v1.json")) as {
      version: number;
      server: {
        rows: Array<Record<string, unknown>>;
        supportedPurePythonImports: Record<string, string[]>;
      };
      browser: {
        rows: Array<Record<string, unknown>>;
        browserExecutedFixtureFamilies: string[];
      };
    };

    expect(doc.version).toBe(1);
    expect(Array.isArray(doc.server.rows)).toBe(true);
    expect(doc.server.rows.length).toBeGreaterThan(0);
    expect(Object.keys(doc.server.supportedPurePythonImports)).toEqual([
      "node",
      "deno",
      "bun",
    ]);
    expect(Array.isArray(doc.browser.rows)).toBe(true);
    expect(doc.browser.rows.length).toBeGreaterThan(0);
    expect(doc.browser.browserExecutedFixtureFamilies.length).toBeGreaterThan(
      0,
    );
  });

  it("keeps contributor-facing claim blocks aligned with the generated artifacts", () => {
    const supportMatrix = read("docs/support-matrix.md");
    const compatibilityMatrix = read("docs/reference/compatibility-matrix.md");
    const docsCheck = read("scripts/docs_check.mjs");
    const compatCheck = read("scripts/compat_check.mjs");
    const topLevelCheck = read("scripts/check");

    expect(supportMatrix).toContain(
      "artifacts/compat/server-compatibility-matrix.json",
    );
    expect(supportMatrix).toContain(
      "artifacts/compat/browser-capability-matrix.json",
    );
    expect(supportMatrix).toContain("<!-- server-claim-rows:start -->");
    expect(supportMatrix).toContain("<!-- browser-claim-rows:start -->");

    expect(compatibilityMatrix).toContain(
      "<!-- server-package-claims:start -->",
    );
    expect(compatibilityMatrix).toContain(
      "<!-- browser-fixture-claims:start -->",
    );

    expect(docsCheck).toContain("server-compatibility-matrix.json");
    expect(docsCheck).toContain("browser-capability-matrix.json");
    expect(compatCheck).toContain("server-compatibility-matrix.json");
    expect(compatCheck).toContain("browser-capability-matrix.json");
    expect(topLevelCheck).toContain("bash scripts/evidence_claims_check");
  });
});
