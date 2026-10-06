import { unzipSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { levelOf, stripHtml, type ApkgNote, type ApkgOut } from "../apkg-format";

function parse(buffer: ArrayBuffer, SQL: SqlJsStatic): ApkgOut {
  const files = unzipSync(new Uint8Array(buffer));
  const dbKey = ["collection.anki2", "collection.anki21b", "collection.anki21"].find(
    (k) => k in files,
  );
  if (!dbKey) throw new Error("El .apkg no contiene collection.anki2");

  let bytes: Uint8Array = files[dbKey]!;
  // magic de zstd: algunos exportadores comprimen la base
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    bytes = zstdDecompress(bytes) as Uint8Array<ArrayBuffer>;
  }

  const handle = new SQL.Database(bytes as Uint8Array<ArrayBuffer>);
  const q = <T>(sql: string): T[] => {
    const stmt = handle.prepare(sql);
    const out: T[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as T);
    stmt.free();
    return out;
  };

  // Deck names: schema 18 usa tabla `decks`; schema 11 usa col.decks (JSON).
  const deckNames = new Map<number, string>();
  const hasDecksTable =
    q<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='decks'`)
      .length > 0;

  if (hasDecksTable) {
    for (const r of q<{ id: number; name: string }>(`SELECT id, name FROM decks`)) {
      deckNames.set(r.id, r.name);
    }
  } else {
    const col = q<{ decks: string }>(`SELECT decks FROM col`)[0];
    const parsed = JSON.parse(col?.decks ?? "{}") as Record<string, { name?: string }>;
    for (const [id, d] of Object.entries(parsed)) {
      if (d?.name) deckNames.set(Number(id), d.name);
    }
  }

  // En el esquema de Anki la PK de `notes` se llama `id`; `cards.nid` apunta a
  // ella. `notes.nid` no existe.
  const cardDeck = new Map<number, number>();
  for (const c of q<{ nid: number; did: number }>(`SELECT nid, did FROM cards`)) {
    if (!cardDeck.has(c.nid)) cardDeck.set(c.nid, c.did);
  }

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
      fields: n.flds.split("\x1f").map(stripHtml),
    });
  }

  handle.close();
  return { ok: true, notes, decks: [...seenDecks] };
}

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
    self.postMessage(parse(ev.data.buffer, SQL));
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
