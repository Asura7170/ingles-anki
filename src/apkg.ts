import type { IngestResult } from "./ingest";
import { ingest, type IngestItem } from "./ingest";
import { db } from "./db";
import { identify, type Identity } from "./identity";
import { MAX_IMAGE_BYTES, mimeOf, rootOf, type ApkgNote, type ApkgOut } from "./apkg-format";

let worker: Worker | null = null;

const WORKER_TIMEOUT_MS = 45_000;

function runWorker(buffer: ArrayBuffer): Promise<ApkgOut> {
  worker ??= new Worker(new URL("./workers/apkg.worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  return new Promise((resolve, reject) => {
    // Nunca colgarse en silencio: un worker que no responde es un bug, no una espera.
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("El worker de .apkg no respondió. Recarga la página e inténtalo otra vez."));
    }, WORKER_TIMEOUT_MS);

    const onMessage = (ev: MessageEvent<ApkgOut>) => {
      cleanup();
      resolve(ev.data);
    };
    const onError = (ev: ErrorEvent) => {
      cleanup();
      reject(new Error(ev.message || "Fallo el worker de .apkg"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.postMessage({ buffer }, [buffer]);
  });
}

/**
 * El campo 0 a veces es un código ("1000BEW_B01_U01_001"), no la palabra.
 * Con minúsculas no es código ("COVID-19", "Chapter 5" se quedan); sin
 * dígito tampoco ("TV" se queda). Heurística, como todo en esta función.
 */
const isCode = (f: string) =>
  /\d/.test(f) && !/[a-z]/.test(f) && (f.includes("_") || /^[\d]/.test(f));

/**
 * ¿Menciona el campo a la palabra (en cualquier flexión)? Es el mismo
 * `identify` que usa `blankSentence` para dibujar el hueco: si dice que sí,
 * el hueco existe por construcción.
 */
function mentionsHeadword(field: string, lemma: string | undefined): boolean {
  if (!lemma) return false;
  return field.split(/\s+/).some((tok) => identify(tok)?.lemma === lemma);
}

/**
 * Mapeo heurístico de campos. field[0] = palabra (o el primer campo que no
 * sea código); ejemplo = el campo donde APARECE la palabra, no el más largo;
 * el resto = traducciones. Los .apkg no tienen contrato sobre qué campo es
 * qué, así que esto es mejor que nada y no peor.
 *
 * El "más largo" elegía definiciones ("to make a car move" le ganaba a "He
 * drives to work.") y la card caía a rama word-only: la frase existe en el
 * mazo pero no se mostraba. El fallback conserva la regla vieja para mazos
 * donde la palabra no aparece en ningún campo.
 */
function mapFields(fields: string[]): {
  headword: string;
  translations: string[];
  example?: string;
} {
  const clean = fields.filter(Boolean);
  // Salta códigos iniciales: el ID va primero y la palabra después. El tope
  // guarda el último: si TODO son códigos, headword es el último y no "".
  let start = 0;
  while (start < clean.length - 1 && isCode(clean[start]!)) start++;
  const headword = clean[start] ?? "";
  const rest = clean.filter((_, i) => i !== start);
  const lemma = identify(headword)?.lemma;

  const longest = (pool: { f: string; i: number }[]): { f: string; i: number } | undefined => {
    let best: { f: string; i: number } | undefined;
    for (const c of pool) {
      if (!best || c.f.length > best.f.length) best = c;
    }
    return best;
  };

  // Primero la frase (≥3 palabras: "They watch a movie." tiene 4); si ninguna
  // la menciona, la regla vieja (más largo con ≥5).
  const withWord = rest
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.split(/\s+/).length >= 3 && mentionsHeadword(f, lemma));
  const legacy = rest.map((f, i) => ({ f, i })).filter(({ f }) => f.split(/\s+/).length >= 5);
  const pick = longest(withWord.length ? withWord : legacy);
  const example = pick?.f ?? "";
  const exampleIdx = pick?.i ?? -1;

  return {
    headword,
    translations: rest.filter((_, i) => i !== exampleIdx),
    example: example || undefined,
  };
}

export interface ApkgImport {
  deckId: number;
  deckName: string;
  result: IngestResult;
  skipped: number;
  /** Imágenes referenciadas que no se guardaron (rotas, enormes, sin mime). */
  skippedImages: number;
}

/**
 * Resuelve los nombres de `note.images` a bytes listos para `ingest`.
 * Pura a propósito: `importApkg` ya está en CC 14 al 0 % y cada rama suya
 * nace ciega. Esto se prueba sin Dexie ni worker.
 *
 * Rota (el mapa la nombra pero el zip no la trae), enorme o con extensión
 * que `<img>` no pinta: la palabra entra igual, sin ella. Anki hace lo mismo
 * al importar: deja la referencia y sigue.
 */
export function resolveImages(
  names: string[],
  media: Record<string, Uint8Array>,
): { images: NonNullable<IngestItem["images"]>; skipped: number } {
  const images: NonNullable<IngestItem["images"]> = [];
  let skipped = 0;
  for (const name of names) {
    const bytes = media[name];
    const mime = mimeOf(name);
    if (!bytes || bytes.length > MAX_IMAGE_BYTES || !mime) {
      skipped++;
      continue;
    }
    images.push({ name, mime, bytes });
  }
  return { images, skipped };
}

/**
 * En un .apkg todo es vocabulario por decisión del usuario: los filtros de
 * transcripciones no pueden saltar notas (have/like/think/know/ill… son
 * palabras del mazo, no muletillas). Si `identify` dice null y queda texto
 * con ≥2 letras, entra como identidad literal. `skipped` queda para lo que
 * ni es texto.
 */
function fallbackIdentity(raw: string): Identity | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (text.replace(/[^\p{L}]/gu, "").length < 2) return null;
  return { lemma: text, kind: text.includes(" ") ? "phrase" : "word" };
}

export async function importApkg(
  file: File,
  parse: (buffer: ArrayBuffer) => Promise<ApkgOut> = runWorker,
): Promise<ApkgImport> {
  // `parse` inyectable: en producción es el worker (sql.js vive allí para no
  // arrastrar el WASM al hilo principal); en tests se pasa `parseApkgBytes`
  // directo, que es la misma función que el worker ejecuta. Sin el seam,
  // `importApkg` sólo se podría probar con un Worker real, que ni happy-dom
  // ni Node exponen.
  const raw = await parse(await file.arrayBuffer());
  if (!raw.ok) throw new Error(raw.error);
  if (raw.notes.length === 0) throw new Error("El mazo no contiene notas.");

  const deckName = rootOf(raw.notes[0]!.deckName) || file.name.replace(/\.apkg$/i, "");

  // Reusar el deck si ya existe: así el re-import detecta cambios por noteId.
  const existing = await db.decks.where("name").equals(deckName).first();
  const deckId =
    existing?.id ??
    (await db.decks.add({ name: deckName, kind: "import", createdAt: Date.now() }))!;

  const total: IngestResult = { created: 0, merged: 0, changed: 0 };
  let skipped = 0;
  let skippedImages = 0;

  // Una pasada por nota: preserva noteId/deckId/level como procedencia, que es
  // lo que permite detectar cambios al reimportar.
  for (const note of raw.notes as ApkgNote[]) {
    const mapped = mapFields(note.fields);
    const id = identify(mapped.headword) ?? fallbackIdentity(mapped.headword);
    if (!id) {
      skipped++;
      continue;
    }

    const resolved = resolveImages(note.images, raw.media);
    skippedImages += resolved.skipped;

    const item: IngestItem = {
      headword: mapped.headword,
      lemma: id.lemma,
      kind: id.kind,
      translations: mapped.translations.slice(0, 3),
      senseTranslations: mapped.translations.slice(0, 3),
      examples: mapped.example ? [{ text: mapped.example }] : undefined,
      images: resolved.images.length ? resolved.images : undefined,
    };

    const r = await ingest([item], {
      kind: "apkg",
      priority: 30,
      deckId,
      noteId: note.noteId,
      level: note.level,
    });
    total.created += r.created;
    total.merged += r.merged;
    total.changed += r.changed;
  }

  return { deckId, deckName, result: total, skipped, skippedImages };
}
