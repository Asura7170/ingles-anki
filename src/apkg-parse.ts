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
import {
  findImages,
  levelOf,
  MAX_IMAGE_BYTES,
  stripHtml,
  type ApkgNote,
  type ApkgOut,
} from "./apkg-format";

/** Las tres bases que ha usado Anki, de nueva a vieja. El orden ya NO decide
 * (decide el nº de notas); solo desempata, y en empate gana la nueva porque
 * el dummy siempre es `anki2`. */
const DB_FILES = ["collection.anki21b", "collection.anki21", "collection.anki2"];

/** Magic bytes de un frame zstd. */
const isZstd = (b: Uint8Array) => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

/**
 * Tamaño declarado del contenido de un frame zstd, o `null` si el header no
 * lo trae. Mismo layout que lee fzstd: descriptor, ventana opcional,
 * diccionario opcional y campo FCS de tamaño variable.
 *
 * ponytail: atajo, no garantía. El FCS es opcional y puede mentir en ambos
 * sentidos (declara poco y expande más); el corte duro exigiría decode en
 * streaming con tope, que para esta app es YAGNI. Esto solo evita la
 * asignación inequívoca: declarado enorme con bytes de sobra para saberlo.
 */
function zstdContentSize(b: Uint8Array): number | null {
  if (b.length < 5) return null;
  const flg = b[4]!;
  const fcf = flg >> 6;
  const ss = (flg >> 5) & 1;
  const dict = flg & 3;
  const fsb = fcf ? 1 << fcf : ss;
  if (!fsb) return null;
  const at = 6 - ss + (dict === 3 ? 4 : dict);
  let n = 0;
  // Multiplicación y no `<<`: un FCS de 8 bytes desborda los 32 bits.
  for (let i = fsb - 1; i >= 0; i--) n = n * 256 + (b[at + i] ?? 0);
  return n + (fcf === 1 ? 256 : 0);
}

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
 * Dos formatos, y la discriminadora es el CONTENIDO, no `meta`:
 *
 * - Legacy: JSON plano `{"0":"cat.jpg"}`.
 * - v3 (Anki 23.10+): zstd + protobuf `MediaEntries`. Cada entrada es un frame
 *   zstd independiente, como la colección, así que se descomprime con el mismo
 *   `isZstd`. El **orden del vector es el índice**; no hay un campo índice.
 *
 * Hay zips v3 (con `meta`) cuyo mapa sigue siendo JSON plano: usar `meta`
 * como discriminadora mandaba ese JSON al parser protobuf, que devolvía mapa
 * vacío y TODAS las imágenes se perdían en silencio. Es el criterio de Anki.
 */
function readMediaMap(files: Record<string, Uint8Array>): Map<string, string> {
  const raw = files.media;
  // Sin `media`: mazo sin imágenes. Anki lo trata como `{}` y no es un error
  // ("older AnkiDroid versions wrote colpkg files without a media map").
  if (!raw) return new Map();

  if (isZstd(raw)) {
    try {
      return readProtoMediaMap(zstdDecompress(raw) as Uint8Array<ArrayBuffer>);
    } catch {
      return new Map(); // mejor sin imagen que sin mazo
    }
  }
  return new Map(Object.entries(safeJson<Record<string, string>>(new TextDecoder().decode(raw))));
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
  // Posicional y no `out.size`: el índice del zip es la POSICIÓN en el vector,
  // exista o no `name`. Con el contador de insertados, una sola entrada
  // anómala desplazaba todo lo que sigue y cruzaba bytes entre imágenes.
  let idx = 0;
  try {
    while (c.i < bytes.length) {
      const wire = protoVarint(c) & 7;
      if (wire !== 2) {
        // Escalar de `MediaEntries`, no una entrada: no ocupa posición en el
        // vector y no consume índice.
        if (!skipProtoField(c, wire)) break;
        continue;
      }
      const len = protoVarint(c);
      const name = protoEntryName(bytes.subarray(c.i, c.i + len));
      c.i += len;
      if (name) out.set(String(idx), name);
      idx++;
    }
  } catch {
    // Mejor parcial que nada: las notas importan igual y las imágenes que sí
    // se resuelven se guardan.
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
 * Notas de una base candidata, o -1 si no abre (corrupta o no es sqlite) o
 * no trae las tablas que el parseo necesita (`notes` sola no basta: sin
 * `cards`/`decks`/`col` las queries de después revientan con SQL crudo).
 * Así la elección no depende de nombres: el dummy trae 0–1 y la real N.
 */
function tryNoteCount(SQL: SqlJsStatic, bytes: Uint8Array): number {
  try {
    const raw = isZstd(bytes) ? zstdDecompress(bytes) : bytes;
    const handle = new SQL.Database(raw as Uint8Array<ArrayBuffer>);
    try {
      const stmt = handle.prepare(`SELECT COUNT(*) AS c FROM notes`);
      const c = stmt.step() ? (stmt.getAsObject() as { c: unknown }).c : -1;
      stmt.free();
      if (typeof c !== "number") return -1;
      const t = handle.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND (name='cards' OR name='decks' OR name='col')`,
      );
      const names = new Set<string>();
      while (t.step()) names.add((t.getAsObject() as { name: unknown }).name as string);
      t.free();
      // `cards` + (`decks` o `col`): lo mínimo que `buildCardDeck`/`readDeckNames` leen.
      return names.has("cards") && (names.has("decks") || names.has("col")) ? c : -1;
    } finally {
      handle.close();
    }
  } catch {
    return -1;
  }
}

/**
 * El dummy de un .apkg v3: una sola nota con el aviso de actualizar Anki
 * ("…newer version of Anki" en las viejas, "…latest Anki version…" en las
 * nuevas). Se pliegan diacríticos y se usa el stem "vers" para pillar
 * "versión"/"versão" (el `i` de JS no pliega acentos). Techo conocido: un
 * mazo real de UNA nota que mencione literalmente "Anki … vers*" se
 * rechaza igual — distinguirlo pediría el marcador exacto por locale.
 * // ponytail: falso positivo aceptado, rarísimo en un mazo de vocabulario.
 */
function isDummyMarker(notes: ApkgNote[]): boolean {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return (
    notes.length <= 1 &&
    notes.some((n) => n.fields.some((f) => /anki.{0,20}vers|vers.{0,20}anki/.test(fold(f))))
  );
}

/**
 * La base real del mazo: la candidata con más notas. Los nombres ya no
 * deciden —el Anki nuevo escribe la real como `anki21` y no `anki21b`, y el
 * `meta` de un exportador de terceros puede faltar—; con nombres solos el
 * dummy `anki2` ganaba por orden de lista y el mazo se importaba como una
 * nota "Please update to the latest Anki version" en un deck "Default".
 *
 * Si solo hay marcador (zip a medias o truncado), se devuelve igual y el
 * llamador lo rechaza con error útil en vez de crear un mazo mentira.
 */
function findCollection(files: Record<string, Uint8Array>, SQL: SqlJsStatic): string | undefined {
  const present = DB_FILES.filter((k) => k in files);
  if (present.length === 0) return undefined;
  // También el candidato único se valida: una base sola y corrupta llegaba
  // hasta `new SQL.Database` y reventaba con el error crudo en inglés.
  if (present.length === 1)
    return tryNoteCount(SQL, files[present[0]!]!) < 0 ? undefined : present[0];
  let best = present[0]!;
  let bestN = -1;
  for (const k of present) {
    const n = tryNoteCount(SQL, files[k]!);
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return bestN < 0 ? undefined : best;
}

export function parseApkgBytes(buffer: ArrayBuffer, SQL: SqlJsStatic): ApkgOut {
  const files = unzipSync(new Uint8Array(buffer));
  const dbKey = findCollection(files, SQL);
  if (!dbKey)
    throw new Error(
      "El .apkg no trae una base válida (collection.anki2/anki21b/anki21 ausente o corrupta)",
    );

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

    // Marcador de Anki y no un mazo: el dummy trae UNA nota que pide
    // actualizar Anki, y `identify` no la salta (la frase entera acaba siendo
    // el lemma). Importarlo creaba un mazo "Default" con una card basura.
    // Mejor un error que un mazo mentira.
    if (isDummyMarker(notes)) {
      throw new Error(
        "Este .apkg solo trae el marcador de Anki (pide actualizar Anki e importar de nuevo): falta la base real. Reexporta el mazo o vuelve a descargarlo.",
      );
    }

    // Sólo lo que alguna nota referencia, y sólo las entradas que el mapa
    // resuelve. El mapa nombra TODO el media del mazo (el audio incluido, que
    // `findImages` ni mira): descomprimir y clonar lo que nadie resuelve es
    // memoria regalada. Las entradas del zip se llaman por índice, nunca por
    // nombre, y el índice puede tener huecos (el exportador legacy salta
    // ficheros que no existen), así que se itera el mapa y no se asume
    // `0..N-1`.
    const referenced = new Set(notes.flatMap((n) => n.images));
    const media: Record<string, Uint8Array> = {};
    for (const [index, name] of mediaMap) {
      if (!referenced.has(name)) continue;
      const entry = files[index];
      if (!entry) continue;
      // Atajo FCS: si declara más de lo que guardamos, ni se descomprime. La
      // palabra entra igual y `resolveImages` lo cuenta como saltada (llega
      // sin bytes, igual que una rota).
      if (isZstd(entry)) {
        const declared = zstdContentSize(entry);
        if (declared !== null && declared > MAX_IMAGE_BYTES) continue;
      }
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
