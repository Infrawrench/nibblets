import { defineConfig } from "vitest/config";

// Whole stacks and real machines: slow, and one at a time.
export default defineConfig({
  test: {
    include: ["*.test.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    fileParallelism: false,
  },
});
