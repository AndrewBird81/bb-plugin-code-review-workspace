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
        },
      },
    ],
  },
});
