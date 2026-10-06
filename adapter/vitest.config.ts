import { defineConfig } from "vitest/config";

// Même garde-fou que le plugin : la référence des tests est un HOME temporaire, jamais le vrai dossier du compte.
export default defineConfig({
  test: { setupFiles: ["../vitest.setup.ts"], exclude: ["**/node_modules/**", "**/dist/**"] },
});
