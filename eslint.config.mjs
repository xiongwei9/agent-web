import js from "@eslint/js";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  ...globals.node,
};

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "packages/agno-server/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["packages/**/*.{ts,tsx}"],
  })),
  {
    files: ["packages/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...nodeGlobals,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  eslintPluginPrettierRecommended,
];
