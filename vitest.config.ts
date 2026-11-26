import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

const alias: Record<string, string> = {
  "~~/": `${path.resolve(root, "./")}/`,
  "~~": path.resolve(root, "./"),
  "~/": `${path.resolve(root, "./src")}/`,
  "~": path.resolve(root, "./src"),
};

const sharedTest = {
  environment: "node" as const,
  hookTimeout: 60_000 * 5,
  testTimeout: 150_000,
};

export default defineConfig({
  resolve: { alias },
  test: {
    watch: false,
    coverage: {
      enabled: false,
      reporter: ["html", "text-summary"],
      cleanOnRerun: true,
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.d.ts",
        "src/types/**",
        "src/main.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "units",
          include: [
            "src/**/__tests__/**/*.unit.{test,spec}.ts",
            "src/**/__tests__/**/*.{test,spec}.ts",
          ],
          exclude: [
            "src/**/__tests__/**/*.int.{test,spec}.ts",
            "src/**/__tests__/**/*.integration.{test,spec}.ts",
          ],
          setupFiles: ["./test/units.setup.ts"],
          ...sharedTest,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: [
            "src/**/__tests__/**/*.int.{test,spec}.ts",
            "src/**/__tests__/**/*.integration.{test,spec}.ts",
          ],
          globalSetup: ["./test/globalSetup.ts"],
          setupFiles: ["./test/integration.setup.ts"],
          fileParallelism: false,
          pool: "threads",
          maxConcurrency: 1,
          ...sharedTest,
        },
      },
    ],
  },
});
