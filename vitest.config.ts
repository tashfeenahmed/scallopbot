import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15000,
    // Several E2E suites spawn real subprocesses, SQLite connections, and
    // loopback servers. Unbounded file-level parallelism can starve those
    // processes until their behavioral timeout expires, producing unrelated
    // one-off failures on high-core hosts. Four workers retains parallelism
    // while keeping the public suite deterministic under load.
    maxWorkers: 4,
    include: ['src/**/*.test.ts'],
    exclude: ['src/eval/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', '**/*.test.ts'],
    },
  },
});
