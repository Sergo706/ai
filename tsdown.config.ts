import { defineConfig, type UserConfig } from "tsdown";

const shared: UserConfig = {
  target: ["node18", "es2020"],
  format: ["esm", "cjs"],
  clean: true,
  sourcemap: true,
  tsconfig: "tsconfig.json",
  dts: true,
  failOnWarn: true,
  treeshake: true,
  publint: {
    level: "error",
    strict: true,
  },
  attw: {
    profile: "strict",
    level: "error",
  },
  deps: {
    neverBundle: true,
    onlyBundle: [],
  },
  copy: [
    {
      from: "assets/**/*",
      to: "dist/assets",
      flatten: false,
    },
  ],
};

export default defineConfig([
  {
    ...shared,
    entry: { main: "./src/main.ts" },
  },
]);
