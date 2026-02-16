import js from "@eslint/js";
import tseslint from "typescript-eslint";

const controlPlaneIgnore = ".aegispy" + "_pack/**";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-undef": "off",
    },
  },
  {
    ignores: [
      "dist/**",
      "artifacts/**",
      "target/**",
      ".tools/**",
      controlPlaneIgnore,
    ],
  },
];
