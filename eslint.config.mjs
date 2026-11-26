import { defineStrictTSConfig } from "@riavzon/utils/eslint/strict";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default [
  ...defineStrictTSConfig({
    rootDir: __dirname,
    extraIgnores: [
      "*.config.*",
      "*.json",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "**/dist/**",
      "web/**",
    ],
  }),
  {
    files: ["**/__tests__/**/*.ts", "**/test/**/*.ts", "**/*.{test,spec}.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  eslintConfigPrettier,
];
