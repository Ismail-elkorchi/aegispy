import { describe, expect, it } from "vitest";
import {
  normalizeBundleTarget,
  readServerBundleManifest,
  resolveCurrentServerBundle,
  resolveServerBundle,
} from "../src/runtime/server-bundle-manifest";

describe("server bundle manifest", () => {
  it("resolves the current target bundle with explicit metadata", () => {
    const bundle = resolveCurrentServerBundle();
    const target = normalizeBundleTarget();

    expect(bundle.runtimeFamily).toBe("server-wasi-component");
    expect(bundle.bundleId).toBe(
      `server-wasi-component-${target.os}-${target.arch}-cpython-3.14-base`,
    );
    expect(bundle.os).toBe(target.os);
    expect(bundle.arch).toBe(target.arch);
    expect(bundle.pythonAbi).toBe("cpython-3.14");
    expect(bundle.packageSetVersion).toBe("base");
    expect(bundle.engine.modulePath).toBe("artifacts/engine/cpython-wasi.wasm");
    expect(bundle.engine.runtimeDir).toBe("artifacts/engine/wasi-python");
    expect(bundle.component.binaryPath).toBe(
      "artifacts/component/aegispy.component.wasm",
    );
    expect(bundle.component.buildManifestPath).toBe(
      "artifacts/component/build.json",
    );
    expect(bundle.packageLayers).toEqual([]);
  });

  it.each([
    { os: "linux", arch: "x64", platform: "linux" },
    { os: "linux", arch: "arm64", platform: "linux" },
    { os: "darwin", arch: "x64", platform: "darwin" },
    { os: "darwin", arch: "arm64", platform: "darwin" },
    { os: "windows", arch: "x64", platform: "win32" },
    { os: "windows", arch: "arm64", platform: "win32" },
  ] as const)(
    "resolves bundle metadata for $os/$arch",
    ({ os, arch, platform }) => {
      const manifest = readServerBundleManifest();
      const bundle = resolveServerBundle(
        manifest,
        normalizeBundleTarget({
          platform,
          arch,
        }),
      );

      expect(bundle.runtimeFamily).toBe("server-wasi-component");
      expect(bundle.bundleId).toBe(
        `server-wasi-component-${os}-${arch}-cpython-3.14-base`,
      );
      expect(bundle.os).toBe(os);
      expect(bundle.arch).toBe(arch);
    },
  );

  it("rejects missing target-specific bundle entries", () => {
    expect(() =>
      resolveServerBundle(
        {
          schemaVersion: 1,
          artifacts: {},
          bundles: {},
        },
        {
          os: "linux",
          arch: "x64",
          pythonAbi: "cpython-3.14",
          packageSetVersion: "base",
        },
      ),
    ).toThrow(/bundle/i);
  });
});
