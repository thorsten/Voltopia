import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The multi-day simulation suites (heat, integration) take 6-8 s
    // locally under coverage and 2-3x that on shared CI runners, which
    // also starve vitest's worker threads — at 30 s they timed out once
    // the railways landed. Keep per-tick costs down (gate steps whose
    // feature is absent) rather than leaning on this value.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/sim/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['src/sim/worker.ts', 'src/**/*.test.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
