/**
 * Lectura de un `.apkg`. Vive fuera del worker para que los tests puedan
 * ejecutarlo de verdad: antes estaba dentro de `apkg.worker.ts`, que se carga
 * con `new Worker(...)` y por tanto no es importable desde un test de node. Los
 * tests mantenían una réplica de estas queries, y una réplica no falla cuando la
 * query original cambia.
 *
 * El worker conserva la carga perezosa del WASM (326 KB) y sólo delega aquí.
 */

import { unzipSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";
import type { SqlJsStatic } from "sql.js";
import { levelOf, stripHtml, type ApkgNote, type ApkgOut } from "./apkg-format";

/** Los tres nombres que ha usado Anki para la base del mazo. */
const DB_FILES = ["collection.anki2", "collection.anki21b", "collection.anki21"];

/** Magic bytes de un frame zstd. */
const isZstd = (b: Uint8Array) => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

/**
 * Nombres de mazo por id. Hay dos esquemas en circulación y no se puede asumir
 * el moderno: schema 18 usa la tabla `decks`, schema 11 (y todo mazo exportado
 * por versiones antiguas o por herramientas de terceros) guarda un JSON en
 * `col.decks` con claves por id en string.
 */
function readDeckNames(q: <T>(sql: string) => T[]): Map<number, string> {
  const names = new Map<number, string>();
  const hasTable = q<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='decks'`,
  ).length;

  if (hasTable) {
    for (const r of q<{ id: number; name: string }>(`SELECT id, name FROM decks`)) {
      names.set(r.id, r.name);
    }
  } else {
    const col = q<{ decks: string }>(`SELECT decks FROM col`)[0];
    // JSON inválido o ausente: el mazo entero se degrada a "Sin deck" en vez de
    // perder todas las palabras.
    const parsed = safeJson<Record<string, { name?: string }>>(col?.decks ?? "{}");
    for (const [id, d] of Object.entries(parsed)) {
      if (d?.name) names.set(Number(id), d.name);
    }
  }
  return names;
}

function safeJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

/**
 * En el esquema de Anki la PK de `notes` se llama `id` y `cards.nid` apunta a
 * ella; `notes.nid` no existe. Una nota puede tener varias cards en distintos
 * sub-decks: se queda con la primera, que es la del mazo principal.
 */
function buildCardDeck(q: <T>(sql: string) => T[]): Map<number, number> {
  const byNote = new Map<number, number>();
  for (const c of q<{ nid: number; did: number }>(`SELECT nid, did FROM cards`)) {
    if (!byNote.has(c.nid)) byNote.set(c.nid, c.did);
  }
  return byNote;
}

/**
 * La base real del mazo. `meta` es la discriminadora, no el orden de `DB_FILES`:
 * desde Anki 23.10 el `.apkg` por defecto lleva `collection.anki21b` con los datos
 * y **además** un `collection.anki2` dummy con una nota de aviso. Como `find`
 * devuelve el primero que exista, el orden de `DB_FILES` solo elegía el dummy.
 */
function findCollection(files: Record<string, Uint8Array>): string | undefined {
  return "meta" in files ? "collection.anki21b" : DB_FILES.find((k) => k in files);
}

export function parseApkgBytes(buffer: ArrayBuffer, SQL: SqlJsStatic): ApkgOut {
  const files = unzipSync(new Uint8Array(buffer));
  const dbKey = findCollection(files);
  if (!dbKey) throw new Error("El .apkg no contiene collection.anki2");

  let bytes = files[dbKey]!;
  // Algunos exportadores comprimen la base con zstd.
  if (isZstd(bytes)) bytes = zstdDecompress(bytes) as Uint8Array<ArrayBuffer>;

  const handle = new SQL.Database(bytes as Uint8Array<ArrayBuffer>);
  try {
    const q = <T>(sql: string): T[] => {
      const stmt = handle.prepare(sql);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      stmt.free();
      return out;
    };

    const deckNames = readDeckNames(q);
    const cardDeck = buildCardDeck(q);

    const notes: ApkgNote[] = [];
    const seenDecks = new Set<string>();
    for (const n of q<{ id: number; flds: string }>(`SELECT id, flds FROM notes`)) {
      const did = cardDeck.get(n.id) ?? 0;
      const deckName = deckNames.get(did) ?? "Sin deck";
      seenDecks.add(deckName);
      notes.push({
        noteId: n.id,
        deckId: did,
        deckName,
        level: levelOf(deckName),
        // \x1f es el separador de campos de Anki, no una tabulador.
        fields: n.flds.split("\x1f").map(stripHtml),
      });
    }

    return { ok: true, notes, decks: [...seenDecks] };
  } finally {
    handle.close();
  }
}
