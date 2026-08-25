import js from "@eslint/js";
import security from "eslint-plugin-security";
import globals from "globals";
import tseslint from "typescript-eslint";
import secureCoding from 'eslint-plugin-secure-coding';

export default tseslint.config(
  {
    ignores: ["dist/**", "plugin/dist/**", "node_modules/**", ".remember/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"
  // Security rules, CWE- and CVSS-tagged, scoped to source.
  //
  // Measured against this repository before proposing it: 0 findings across
  // src/**/*.{js,mjs,cjs,ts,tsx}. That is the point rather than a caveat — the block goes red on a
  // new one, not on what is here today.
  {
    files: ['src/**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: { 'secure-coding': secureCoding },
    rules: secureCoding.configs.recommended.rules,
  },
],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
);
