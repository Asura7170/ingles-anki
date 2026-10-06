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
}

export type ApkgOut =
  | { ok: true; notes: ApkgNote[]; decks: string[] }
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
