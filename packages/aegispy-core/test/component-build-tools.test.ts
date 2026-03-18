import { describe, expect, it } from "vitest";

const componentBuildModulePath = "../../../scripts/component/build.mjs";
const { buildWacPlugArgs, resolveBundledWac } = (await import(
  componentBuildModulePath
)) as {
  buildWacPlugArgs(input: {
    wrapperComponentPath: string;
    dependencyComponentPath: string;
    outputComponentPath: string;
  }): string[];
  resolveBundledWac(platformKey?: string): {
    fileName: string;
    sha256: string;
  };
};

describe("component build tooling", () => {
  it("builds the pinned wac plug command for component composition", () => {
    expect(
      buildWacPlugArgs({
        wrapperComponentPath: "wrapper.wasm",
        dependencyComponentPath: "base.wasm",
        outputComponentPath: "out.wasm",
      }),
    ).toEqual([
      "plug",
      "wrapper.wasm",
      "--plug",
      "base.wasm",
      "-o",
      "out.wasm",
    ]);
  });

  it("pins the bundled linux wac asset", () => {
    expect(resolveBundledWac("linux:x64")).toEqual({
      fileName: "wac-cli-x86_64-unknown-linux-musl",
      sha256:
        "c992dd14dd7d67d687f70f77347d9523be6c04eb9845351bf2a1f24dee1bbfc8",
    });
  });

  it("rejects unsupported bundled wac platforms", () => {
    expect(() => resolveBundledWac("darwin:x64")).toThrow(
      "unsupported platform for bundled wac",
    );
  });
});
