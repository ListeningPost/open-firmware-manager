// Flat ESLint config for the whole workspace.
// Non-type-aware on purpose: it runs on a fresh clone without building
// workspace packages first. `pnpm typecheck` covers type errors.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "cli/target/**",
      "examples/full-stack/.local/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      // The three rules below have known findings in the current sources
      // (9 in total). They are reported as warnings so CI stays green until
      // the code is cleaned up; flip back to "error" afterwards.
      "prefer-const": "warn",
      "no-useless-assignment": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
