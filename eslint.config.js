import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Only the promise rules, which need type information: once the Store is async, each call's Promise must be awaited or handed on.
export default defineConfig([
  globalIgnores(["dist/"]),
  {
    files: ["server.ts", "src/**/*.ts", "scripts/**/*.ts"],
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
