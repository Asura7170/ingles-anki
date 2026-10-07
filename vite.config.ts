import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  // NO excluir sql.js: su build de navegador es UMD y necesita el interop de
  // esbuild. Excluirlo rompe el default export en el bundle del worker.
  optimizeDeps: { exclude: ["fzstd"] },
  test: {
    // node por defecto: la mayoría del código es lógica pura y un DOM aquí sólo
    // añadiría coste. Los ficheros de componentes optan con
    // `// @vitest-environment happy-dom` en la primera línea.
    environment: "node",
    // TSX fuera de `environment: "node"` necesita un transformer de JSX. Sin esto
    // el fichero se parsea pero React nunca monta.
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      // "lcov" no es decorativo: es el único formato que lee crapper para
      // puntuar CRAP = CC²·(1-cobertura)³ + CC por función.
      reporter: ["text", "html", "lcov"],
      // Todo src/, no solo el núcleo: crapper puntúa 0% cualquier función
      // ausente del informe LCOV, y una lista corta puntúa 0% las vistas por
      // el mero hecho de no estar listadas. Los test se excluyen porque
      // inflan la cobertura global.
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.ts"],
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
