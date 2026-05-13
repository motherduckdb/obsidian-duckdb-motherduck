import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";

// Note: `eslint-plugin-obsidianmd@0.3.0` recommended config does NOT include
// directive-comment rules; the Obsidian Community dashboard scan layers them
// on top. Add them here so `npm run lint` reproduces the dashboard's findings.

const RESTRICTED_DISABLES = [
  // Critical rules the dashboard does not let plugin authors silence.
  "obsidianmd/no-global-this",
];

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
      "@eslint-community/eslint-comments/require-description": [
        "error",
        { ignore: [] },
      ],
      "@eslint-community/eslint-comments/no-restricted-disable": [
        "error",
        ...RESTRICTED_DISABLES,
      ],
    },
  },
];
