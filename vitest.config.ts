import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "e2e", include: ["e2e/**/*.test.ts"], environment: "node" } },
      {
        test: {
          name: "backend",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "frontend",
          include: ["components/**/*.test.tsx", "lib/**/*.test.ts"],
          environment: "jsdom",
          // A file's first render imports the whole app cold: about 2 s alone, and past the 5 s default under load.
          testTimeout: 15_000,
        },
      },
    ],
  },
});
