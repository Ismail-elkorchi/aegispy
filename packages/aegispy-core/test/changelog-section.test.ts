import { describe, expect, it } from "vitest";

const changelogSectionModulePath = "../../../scripts/changelog-section.mjs";
const { resolveChangelogTag } = (await import(changelogSectionModulePath)) as {
  resolveChangelogTag(input: {
    envRefName?: string | null;
    cliArgs?: string[];
  }): string;
};

describe("changelog section", () => {
  it("prefers an explicit tag argument over the ambient ref name", () => {
    expect(
      resolveChangelogTag({
        envRefName: "main",
        cliArgs: ["v0.0.0"],
      }),
    ).toBe("v0.0.0");
  });

  it("falls back to the ambient ref name when no explicit tag is provided", () => {
    expect(
      resolveChangelogTag({
        envRefName: "v0.0.0",
        cliArgs: [],
      }),
    ).toBe("v0.0.0");
  });
});
