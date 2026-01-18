import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@gent/core": path.resolve(__dirname, "packages/core/src"),
      "@gent/storage": path.resolve(__dirname, "packages/storage/src"),
      "@gent/tools": path.resolve(__dirname, "packages/tools/src"),
      "@gent/providers": path.resolve(__dirname, "packages/providers/src"),
      "@gent/runtime": path.resolve(__dirname, "packages/runtime/src"),
      "@gent/api": path.resolve(__dirname, "packages/api/src"),
      "@gent/test-utils": path.resolve(__dirname, "packages/test-utils/src"),
    },
  },
})
