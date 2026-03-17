import { describe, expect, it } from "vitest";

const releaseGateModulePath = "../../../scripts/release-gate.mjs";
const { resolveReleaseTag } = (await import(releaseGateModulePath)) as {
  resolveReleaseTag(input: {
    envRefName?: string | null;
    cliArgs?: string[];
  }): string;
};

describe("release gate", () => {
  it("prefers an explicit tag argument over the ambient ref name", () => {
    expect(
      resolveReleaseTag({
        envRefName: "main",
        cliArgs: ["v0.0.0"],
      }),
    ).toBe("v0.0.0");
  });

  it("falls back to the ambient ref name when no explicit tag is provided", () => {
    expect(
      resolveReleaseTag({
        envRefName: "v0.0.0",
        cliArgs: [],
      }),
    ).toBe("v0.0.0");
  });
});
