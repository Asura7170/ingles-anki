import type { IngestResult } from "./ingest";
import { ingest, type IngestItem } from "./ingest";
import { db } from "./db";
import { identify } from "./identity";
import { rootOf, type ApkgNote, type ApkgOut } from "./apkg-format";

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
 * Mapeo heurístico de campos. field[0] = palabra; el campo más largo con >=5
 * palabras = ejemplo; el resto = traducciones. Los .apkg no tienen contrato
 * sobre qué campo es qué, así que esto es mejor que nada y no peor.
 */
function mapFields(fields: string[]): {
  headword: string;
  translations: string[];
  example?: string;
} {
  const clean = fields.filter(Boolean);
  const headword = clean[0] ?? "";
  const rest = clean.slice(1);

  let example = "";
  let exampleIdx = -1;
  rest.forEach((f, i) => {
    if (f.split(/\s+/).length >= 5 && f.length > example.length) {
      example = f;
      exampleIdx = i;
    }
  });

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
}

export async function importApkg(file: File): Promise<ApkgImport> {
  const raw = await runWorker(await file.arrayBuffer());
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

  // Una pasada por nota: preserva noteId/deckId/level como procedencia, que es
  // lo que permite detectar cambios al reimportar.
  for (const note of raw.notes as ApkgNote[]) {
    const mapped = mapFields(note.fields);
    const id = identify(mapped.headword);
    if (!id) {
      skipped++;
      continue;
    }

    const item: IngestItem = {
      headword: mapped.headword,
      lemma: id.lemma,
      kind: id.kind,
      translations: mapped.translations.slice(0, 3),
      senseTranslations: mapped.translations.slice(0, 3),
      examples: mapped.example ? [{ text: mapped.example }] : undefined,
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

  return { deckId, deckName, result: total, skipped };
}
