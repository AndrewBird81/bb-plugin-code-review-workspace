import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "e2e", include: ["e2e/**/*.test.ts"], environment: "node" } },
      {
        test: {
          name: "backend",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          environment: "node",
          // No test may run the real gh. The Store runs on Postgres when CRW_TEST_PG_URL is set.
          setupFiles: ["src/real-gh.test-support.ts", "src/test-backend.test-support.ts"],
        },
      },
      {
        test: {
          name: "frontend",
          include: ["components/**/*.test.{ts,tsx}", "lib/**/*.test.{ts,tsx}", "hooks/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          // A file's first render imports the whole app cold: about 2 s alone, and past the 5 s default under load.
          testTimeout: 15_000,
        },
      },
    ],
  },
});
