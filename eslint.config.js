import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Only the promise rules, which need type information: once the Store is async, each call's Promise must be awaited or handed on.
export default defineConfig([
  globalIgnores(["dist/"]),
  {
    // The backend, and the frontend tests and e2e tests that create a Store; the rest of the frontend doesn't call it.
    files: ["server.ts", "src/**/*.ts", "scripts/**/*.ts", "e2e/**/*.ts", "components/overview-chapter-id.test.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
]);
