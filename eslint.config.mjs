import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";

// `eslint-plugin-obsidianmd@0.3.0`'s recommended config doesn't enforce
// directive-comment hygiene; the Community dashboard scan does. Pull in
// `require-description` so any `eslint-disable` has to carry a rationale.

export default [
  {
    ignores: [
      "main.js",
      "node_modules/**",
      "test/**",
      "scripts/**",
      "docs/**",
      "eslint.config.mjs",
      "esbuild.config.mjs",
      "version-bump.mjs",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
        sourceType: "module",
      },
    },
    plugins: {
      "@eslint-community/eslint-comments": eslintComments,
    },
    rules: {
      "obsidianmd/ui/sentence-case": "off",
      "@eslint-community/eslint-comments/require-description": "error",
    },
  },
];
