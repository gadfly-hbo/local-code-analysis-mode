import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CLI-seam tests spawn sandbox-exec + Python per invocation; under parallel
    // load a 5s default produces flakes. 30s keeps the verify gate deterministic.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
