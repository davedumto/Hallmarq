import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "artifacts/**",
      "cache/**",
      "typechain-types/**",
      "types/**",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["packages/*/vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Plain JS tooling scripts: lint them, but without type-aware rules —
    // they're not part of any package's tsconfig program.
    files: ["tools/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Hardhat/ethers contract tests: without compiled typechain-types,
    // ethers.deployContract() returns a generically-typed Contract whose
    // methods and return values are `any`. There's no way to call a
    // contract method here and keep the type-aware unsafe-* rules happy.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
