/**
 * Formato .apkg: tipos y helpers puros.
 *
 * Esto vive FUERA del worker a propósito: el worker tiene un `await
 * initSqlJs()` de nivel superior, así que importarle un valor desde el hilo
 * principal arrastraría el WASM de 326 KB al bundle inicial y bloquearía el
 * arranque.
 */

export interface ApkgNote {
  noteId: number;
  deckId: number;
  deckName: string;
  level: string;
  fields: string[];
  /** Nombres de fichero referenciados por <img> en los campos, en orden. */
  images: string[];
}

export type ApkgOut =
  | { ok: true; notes: ApkgNote[]; decks: string[]; media: Record<string, Uint8Array> }
  | { ok: false; error: string };

export const stripHtml = (s: string): string =>
  s
    .replace(/\[sound:[^\]]*\]/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(div|p)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();

/**
 * Deshace lo mínimo de HTML que Anki puede haber escapado en un `src`.
 *
 * Anki guarda el nombre **crudo** en el campo —con espacios, con `%`, con `&`—
 * y sólo percent-encodifica al mostrar, así que no hay nada que decodificar de
 * URL. Lo único que aparece escapado son entidades, y sólo cuando el nombre
 * original ya las traía. `&amp;` va después de las demás: si fuese primero,
 * `&amp;lt;` se decodificaría dos veces y saldría un `<` que nunca estuvo ahí.
 */
const SRC_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/**
 * Deshace lo mínimo de HTML que Anki puede haber escapado en un `src`.
 *
 * Anki guarda el nombre **crudo** en el campo —con espacios, con `%`, con `&`—
 * y sólo percent-encodifica al mostrar, así que no hay nada que decodificar de
 * URL. Lo único que aparece escapado son entidades, y sólo cuando el nombre
 * original ya las traía.
 *
 * Una sola pasada sobre el string: una cadena de `replace` decodificaría
 * `&amp;lt;` dos veces (primero a `&lt;`, luego a `<`), y ese `<` nunca estuvo
 * en el nombre. Con una sola pasada `&amp;lt;` queda en `&lt;`, que es lo que
 * Anki preserva al re-escapar condicionalmente.
 */
const decodeSrc = (s: string): string =>
  s.trim().replace(/&(quot|apos|#\d+|amp|lt|gt|nbsp);/gi, (m) => {
    const key = m.slice(1, -1).toLowerCase();
    // Sólo la comilla simple llega como numérica; el resto numérico se deja
    // tal cual porque en un nombre de fichero no significa nada.
    const norm = key.startsWith("#") ? (Number(key.slice(1)) === 39 ? "apos" : key) : key;
    return SRC_ENTITIES[norm] ?? m;
  });

/** `^https?://` y `^ftp://`: lo que Anki trata como remoto. */
const isRemote = (s: string) => /^(?:https?|ftp):\/\//i.test(s);

/**
 * Nombres de imagen referenciados por `<img src>` en un campo, ya desescapados,
 * sin remotos y sin duplicados.
 *
 * Se extrae ANTES de `stripHtml`, que se come la etiqueta entera y con ella el
 * nombre. Las comillas van dobles o simples porque el round-trip de Anki usa
 * ambas; el atributo puede llevar espacio alrededor del `=`, y Anki nunca emite
 * `width`/`height` pero un editor de terceros sí.
 *
 * Los remotos se descartan aquí y no en el importador: Anki nunca los descarga
 * (ni al importar ni nunca), así que guardarlos sería una petición a un tercero
 * en cada repaso, sin que el usuario lo pidiera.
 */
export function findImages(field: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of field.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const name = decodeSrc(m[1] ?? m[2] ?? m[3] ?? "");
    if (!name || isRemote(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** La jerarquía de sub-decks ES el nivel. "4000 EW::Book 1" → "Book 1". */
export function levelOf(deckName: string | undefined): string {
  if (!deckName) return "sin nivel";
  const parts = deckName
    .split("::")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" › ") : "raíz";
}

export function rootOf(deckName: string): string {
  // Filtrar vacíos: un deck sin nombre produce "::Subdeck" y el nombre válido es
  // el primer segmento no vacío, no la cadena entera.
  const first = deckName
    .split("::")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return first || deckName.trim() || deckName;
}

/** Extensiones que `<img>` sabe pintar. Una más y hay que forzarla con `type`. */
const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

/**
 * `mime` a partir del nombre. `""` cuando no se reconoce, y el llamador lo
 * trata como saltada: preferimos una palabra sin imagen visible a una etiqueta
 * `img` que el navegador no sabe pintar y que ni siquiera avisa.
 */
export function mimeOf(name: string): string {
  return MIME[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "";
}
