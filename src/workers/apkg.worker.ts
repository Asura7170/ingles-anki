import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { parseApkgBytes } from "../apkg-parse";

/**
 * Carga perezosa: el WASM son 326 KB y sólo hace falta cuando alguien importa
 * un .apkg. Un `await` de nivel superior en el módulo del worker es frágil con
 * el pipeline de Vite y hace que el worker no llegue a instalar su listener.
 */
let sqlPromise: Promise<SqlJsStatic> | null = null;
const getSQL = () => (sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl }));

self.onmessage = async (ev: MessageEvent<{ buffer: ArrayBuffer }>) => {
  try {
    const SQL = await getSQL();
    self.postMessage(parseApkgBytes(ev.data.buffer, SQL));
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
