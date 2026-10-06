import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  // NO excluir sql.js: su build de navegador es UMD y necesita el interop de
  // esbuild. Excluirlo rompe el default export en el bundle del worker.
  optimizeDeps: { exclude: ["fzstd"] },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // El motor de identidad y la fusión son el corazón del sistema: si un
      // lemma sale mal, el filtro de transcripciones se contamina de forma
      // permanente, y si `ingest()` no fusiona, reaprendes lo que ya sabes.
      include: [
        "src/identity.ts",
        "src/diff.ts",
        "src/grade.ts",
        "src/apkg-format.ts",
        "src/ingest.ts",
        "src/translate.ts",
        "src/srs.ts",
      ],
      thresholds: {
        "src/identity.ts": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/diff.ts": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/ingest.ts": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/grade.ts": { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/translate.ts": { statements: 80, branches: 75, functions: 80, lines: 80 },
        "src/srs.ts": { statements: 90, branches: 90, functions: 100, lines: 90 },
      },
    },
  },
});
