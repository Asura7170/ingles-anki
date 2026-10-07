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
import { findImages, levelOf, stripHtml, type ApkgNote, type ApkgOut } from "./apkg-format";

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
 * Lee el mapa `media` del zip: índice-en-texto → nombre original.
 *
 * Dos formatos, y la discriminadora es `meta`:
 *
 * - Legacy: JSON plano `{"0":"cat.jpg"}`.
 * - v3 (Anki 23.10+): zstd + protobuf `MediaEntries`. Cada entrada es un frame
 *   zstd independiente, como la colección, así que se descomprime con el mismo
 *   `isZstd`. El **orden del vector es el índice**; no hay un campo índice.
 *
 * En v1 del proto cada `MediaEntry` es `{ name=1, size=2, sha1=3 }`. Sólo hace
 * falta `name`. Si `meta` no está pero `media` sí, se asume legacy: es el mismo
 * criterio que usa Anki (`zstd_compressed() = !is_legacy()`).
 */
function readMediaMap(files: Record<string, Uint8Array>): Map<string, string> {
  const raw = files.media;
  // Sin `media`: mazo sin imágenes. Anki lo trata como `{}` y no es un error
  // ("older AnkiDroid versions wrote colpkg files without a media map").
  if (!raw) return new Map();

  let bytes = raw;
  if (isZstd(bytes)) {
    try {
      bytes = zstdDecompress(bytes) as Uint8Array<ArrayBuffer>;
    } catch {
      return new Map(); // mejor sin imagen que sin mazo
    }
  }

  const v3 = "meta" in files;
  return v3
    ? readProtoMediaMap(bytes)
    : new Map(Object.entries(safeJson<Record<string, string>>(new TextDecoder().decode(bytes))));
}

/**
 * Decodifica lo justo de `MediaEntries` para sacar `name`: clave de campo
 * varint, longitud varint, bytes. Un mensaje protobuf es `repeated` sin
 * etiqueta de longitud, así que se leen entradas hasta que se acaba el buffer.
 *
 * Escribido a mano y no con una librería porque sólo hacen falta tres campos
 * del schema; un parser genérico por un `MediaEntry` sería más código.
 *
 * Tres funciones y no una con closures anidados: crapper cuenta la complejidad
 * por función, y un solo `readProtoMediaMap` con todo dentro salía en CC 22.
 * Cada una se prueba por separado y el lector de arriba queda lineal.
 */

/** Cursor compartido: `varint` y `skipField` avanzan el mismo índice. */
interface ProtoCursor {
  bytes: Uint8Array;
  i: number;
}

function protoVarint(c: ProtoCursor): number {
  let v = 0;
  let shift = 0;
  for (;;) {
    const b = c.bytes[c.i++];
    if (b === undefined) throw new Error("media truncado");
    v |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return v >>> 0;
    shift += 7;
    if (shift > 35) throw new Error("varint desmesurado");
  }
}

/**
 * Salta un campo sin leerlo. `false` con grupos (wire 3/4), que no aparecen
 * en este schema y ante los que lo correcto es parar, no adivinar.
 */
function skipProtoField(c: ProtoCursor, wire: number): boolean {
  if (wire === 2) {
    c.i += protoVarint(c);
    return true;
  }
  if (wire === 0) {
    protoVarint(c);
    return true;
  }
  if (wire === 5) {
    c.i += 4;
    return true;
  }
  if (wire === 1) {
    c.i += 8;
    return true;
  }
  return false;
}

/**
 * `name` (= campo 1, wire 2) dentro de un `MediaEntry`. El resto —size, sha1,
 * legacy_zip_filename— se salta sin leer. `""` si el submensaje no trae
 * nombre, y el llamador lo descarta: una entrada sin nombre no resuelve nada.
 *
 * Número de campo exterior sin asumir: cualquier submensaje con un `name` en
 * el campo 1 es una entrada. Así no depende del número que `MediaEntries` le
 * asigne a `entries` en cada versión del schema.
 */
function protoEntryName(msg: Uint8Array): string {
  const c: ProtoCursor = { bytes: msg, i: 0 };
  let name = "";
  while (c.i < msg.length) {
    const key = protoVarint(c);
    if ((key & 7) !== 2) {
      if (!skipProtoField(c, key & 7)) break;
      continue;
    }
    const len = protoVarint(c);
    const value = msg.subarray(c.i, c.i + len);
    c.i += len;
    if (key >>> 3 === 1) name = new TextDecoder().decode(value);
  }
  return name;
}

function readProtoMediaMap(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const c: ProtoCursor = { bytes, i: 0 };
  try {
    while (c.i < bytes.length) {
      const wire = protoVarint(c) & 7;
      if (wire !== 2) {
        if (!skipProtoField(c, wire)) break;
        continue;
      }
      const len = protoVarint(c);
      const name = protoEntryName(bytes.subarray(c.i, c.i + len));
      c.i += len;
      if (name) out.set(String(out.size), name);
    }
  } catch {
    // Un mapa a medias es peor que ninguno: las notas importan igual y las
    // imágenes que sí se resuelven se guardan.
  }
  return out;
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

    const mediaMap = readMediaMap(files);

    const notes: ApkgNote[] = [];
    const seenDecks = new Set<string>();
    for (const n of q<{ id: number; flds: string }>(`SELECT id, flds FROM notes`)) {
      const did = cardDeck.get(n.id) ?? 0;
      const deckName = deckNames.get(did) ?? "Sin deck";
      seenDecks.add(deckName);
      // \x1f es el separador de campos de Anki, no una tabulador.
      const raw = n.flds.split("\x1f");
      notes.push({
        noteId: n.id,
        deckId: did,
        deckName,
        level: levelOf(deckName),
        // `findImages` antes de `stripHtml`: la etiqueta desaparece en el
        // stripHtml y con ella el nombre. Se extrae de TODOS los campos, no
        // sólo del que ends up siendo el ejemplo: la imagen va con la palabra,
        // no con la frase.
        images: [...new Set(raw.flatMap(findImages))],
        fields: raw.map(stripHtml),
      });
    }

    // Sólo las entradas que el mapa resuelve. Las entradas del zip se llaman
    // por índice, nunca por nombre, y el índice puede tener huecos (el
    // exportador legacy salta ficheros que no existen), así que se itera el
    // mapa y no se asume `0..N-1`.
    const media: Record<string, Uint8Array> = {};
    for (const [index, name] of mediaMap) {
      const entry = files[index];
      if (!entry) continue;
      try {
        media[name] = isZstd(entry) ? (zstdDecompress(entry) as Uint8Array<ArrayBuffer>) : entry;
      } catch {
        // Imagen corrupta: la nota entra igual, sin ella.
      }
    }

    return { ok: true, notes, decks: [...seenDecks], media };
  } finally {
    handle.close();
  }
}
