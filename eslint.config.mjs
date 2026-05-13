import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

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
    rules: {
      "obsidianmd/ui/sentence-case": "off",
    },
  },
];
