// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // docs/spikes/** holds throwaway spike prototypes (plain Node .mjs, not part
    // of the typed monorepo). They're run directly with `node`, not linted/built.
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      "docs/spikes/**",
      // Agent/tooling worktrees checked out under .claude/ are full repo
      // copies — never lint into them from the primary checkout.
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Plain Node scripts and runnable examples (no TS types) run in the Node
    // runtime. `examples/**` ships executable demo `.mjs` (CAU-27) that use the
    // same Node globals as scripts/.
    files: [
      "scripts/**/*.{js,mjs,cjs}",
      "examples/**/*.{js,mjs,cjs}",
      "*.config.{js,mjs,cjs}",
    ],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
);
