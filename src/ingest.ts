import { db, type Example, type Node, type Source, type SourceKind } from "./db";
import { freqRank, isNGSL, loadFrequency } from "./identity";
import { newCard } from "./srs";

/**
 * Invariante central del sistema. Los cuatro caminos de entrada (.apkg, texto,
 * PDF, IA) llaman a esta función, así que un quinto hereda la deduplicación
 * gratis. Si una palabra ya existe, NO se crea card: se fusiona su contenido.
 */

export interface IngestItem {
  headword: string;
  lemma: string;
  kind: "word" | "phrase";
  translations?: string[];
  gloss?: string;
  examples?: { text: string; translation?: string; fromAi?: boolean }[];
  occurrences?: number;
  senseTranslations?: string[];
  /** Imágenes ya resueltas (bytes en mano), listas para volcar. */
  images?: { name: string; mime: string; bytes: Uint8Array }[];
}

export interface IngestSource {
  kind: SourceKind;
  /** apkg(30) > text|pdf(20) > ai(10) > manual(40) */
  priority: number;
  deckId?: number;
  noteId?: number;
  level?: string;
  sourceTextId?: number;
}

export interface IngestResult {
  created: number;
  merged: number;
  /** Nodos existentes cuyo contenido cambió (re-import con contenido nuevo). */
  changed: number;
}

export const hash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const contentHash = (item: IngestItem) =>
  hash(
    [
      ...(item.translations ?? []),
      ...(item.examples ?? []).map((e) => e.text),
      ...(item.senseTranslations ?? []),
      // Los nombres, no los bytes: el hash decide si el contenido cambió, y
      // una imagen nueva o quitada es cambio de contenido. Hasear MBs por
      // cada nota para decidirlo sería pagar el coste en el camino caliente.
      ...(item.images ?? []).map((m) => m.name),
    ].join("\0"),
  );

async function attachExamples(nodeId: number, examples: IngestItem["examples"], sourceId: number) {
  if (!examples?.length) return;
  const existing = new Set(
    (await db.examples.where("nodeId").equals(nodeId).toArray()).map((e) => e.text),
  );
  const rows: Example[] = [];
  for (const e of examples) {
    const text = e.text.trim();
    if (!text || existing.has(text)) continue;
    existing.add(text);
    rows.push({ nodeId, text, translation: e.translation, sourceId: e.fromAi ? null : sourceId });
  }
  if (rows.length) await db.examples.bulkAdd(rows);
}

/**
 * Vuelca las imágenes resueltas por el importador. Fusión por unión, como todo
 * lo demás: la misma imagen desde dos mazos son dos filas y ninguna pisa a la
 * otra. El dedup es por nombre dentro del nodo, que es lo único barato de
 * comparar sin hasear bytes.
 */
async function attachImages(nodeId: number, images: IngestItem["images"]) {
  if (!images?.length) return;
  const existing = new Set(
    (await db.media.where("nodeId").equals(nodeId).toArray()).map((m) => m.name),
  );
  const rows = images.filter((m) => !existing.has(m.name));
  if (rows.length) await db.media.bulkAdd(rows.map((m) => ({ nodeId, ...m })));
}

async function attachTranslations(nodeId: number, item: IngestItem, sourceKind: SourceKind) {
  const incoming = [...(item.translations ?? []), ...(item.senseTranslations ?? [])]
    .map((t) => t.trim())
    .filter(Boolean);
  if (!incoming.length) return;

  const sense = await db.senses.where("nodeId").equals(nodeId).first();
  if (!sense) return;

  // Fusión por union: nunca sobrescribe. La IA añade alternativa marcada.
  const set = new Set(sense.translations);
  const before = set.size;
  for (const t of incoming) set.add(t);
  if (set.size === before) return;

  await db.senses.update(sense.id!, {
    translations: [...set],
    translationSource: sense.translationSource ?? sourceKind,
  });
}

/**
 * Devuelve el id de la transcripción para `text`, creándola si no existe.
 *
 * Reutilizar en vez de `add` a secas: `sourceTexts` no tiene ninguna pantalla
 * donde verse, así que una fila por cada pegada del mismo texto era basura
 * silenciosa que además crecía con cada ciclo pegar→borrar.
 *
 * Dos detalles:
 *
 * - Se compara el `body` tal cual, sin normalizar. Dos pegadas byte-idénticas
 *   reutilizan; dos equivalentes pero no idénticas (CRLF vs LF, espacio final)
 *   no. Normalizar sería inventar una Canonicalización que además cambia lo que
 *   se guarda y lo que sale en el backup.
 * - `title` NO se sobrescribe. Es un hecho sobre el TEXTO, no sobre el mazo: se
 *   queda el de la primera pegada. Así la columna "Origen" de Palabras no cambia
 *   entre sesiones, y explica por qué dos mazos pueden compartir transcripción.
 *
 * `ingest()` es idempotente con el mismo `sourceTextId`: la identidad de la fila
 * de `sources` es el filtro `prior`, y `contentHash` sólo cubre el contenido del
 * ítem, no el `sourceTextId`. Repetir no duplica nodos ni `sources`. Lo que sí se
 * duplica es `exposure`, que hace `bulkAdd` sin condición; no se corrige porque
 * haría falta un índice compuesto y porque nadie lee esa tabla.
 */
export async function findOrAddSourceText(name: string, text: string): Promise<number> {
  const prior = await db.sourceTexts.filter((t) => t.body === text).first();
  if (prior?.id !== undefined) return prior.id;
  return (await db.sourceTexts.add({
    kind: "text",
    title: name,
    body: text,
    importedAt: Date.now(),
  }))!;
}

export async function ingest(items: IngestItem[], source: IngestSource): Promise<IngestResult> {
  await loadFrequency();
  const now = Date.now();
  const result: IngestResult = { created: 0, merged: 0, changed: 0 };

  await db.transaction("rw", db.nodes, db.senses, db.sources, db.examples, db.media, async () => {
    for (const item of items) {
      const version = contentHash(item);
      const existing = await db.nodes.where("lemma").equals(item.lemma).first();

      let node: Node;
      if (!existing) {
        const id = await db.nodes.add({
          headword: item.headword,
          lemma: item.lemma,
          kind: item.kind,
          known: 0,
          card: newCard(),
          due: now,
          createdAt: now,
          updatedAt: now,
        });
        node = (await db.nodes.get(id))!;
        const senseId = await db.senses.add({
          nodeId: id!,
          gloss: item.gloss,
          translations: [],
          translationSource: null,
          card: newCard(),
          due: now,
        });
        await db.nodes.update(id!, { freqRank: freqRank(item.lemma), ngsl: isNGSL(item.lemma) });
        await db.senses.where("nodeId").equals(id!).first();
        void senseId;
        result.created++;
      } else {
        node = existing;
        result.merged++;
      }

      const sourceRow: Source = {
        nodeId: node.id!,
        kind: source.kind,
        deckId: source.deckId,
        noteId: source.noteId,
        level: source.level,
        sourceTextId: source.sourceTextId,
        occurrenceCount: item.occurrences,
        priority: source.priority,
        contentVersion: version,
        addedAt: now,
      };

      // La identidad de un `source` incluye el deck: dos mazos distintos pueden
      // tener la misma nota con el mismo noteId (Anki numera por deck), y sin
      // deckId el segundo import pisaba al primero y lo dejaba huérfano.
      const prior = await db.sources
        .where("nodeId")
        .equals(node.id!)
        .filter(
          (s) =>
            s.deckId === source.deckId &&
            s.noteId === source.noteId &&
            s.sourceTextId === source.sourceTextId,
        )
        .first();

      if (prior) {
        if (prior.contentVersion !== version) {
          result.changed++;
          await db.sources.update(prior.id!, { ...sourceRow, addedAt: prior.addedAt });
          await db.nodes.update(node.id!, { updatedAt: now });
          // El re-import trae frases nuevas: hay que adjuntarlas igual, o el
          // mazo mejorado se perdería justo lo que lo hace mejor.
          await attachExamples(node.id!, item.examples, prior.id!);
          await attachImages(node.id!, item.images);
        }
      } else {
        const sourceId = (await db.sources.add(sourceRow))!;
        await attachExamples(node.id!, item.examples, sourceId);
        await attachImages(node.id!, item.images);
      }

      await attachTranslations(node.id!, item, source.kind);
    }
  });

  return result;
}

/** Marca todas las palabras de un origen como conocidas (un clic, no 1000). */
export async function markSourceKnown(predicate: (s: Source) => boolean): Promise<number> {
  const sources = (await db.sources.toArray()).filter(predicate);
  const nodeIds = [...new Set(sources.map((s) => s.nodeId))];
  if (!nodeIds.length) return 0;
  await db.nodes.where("id").anyOf(nodeIds).modify({ known: 1 });
  return nodeIds.length;
}
