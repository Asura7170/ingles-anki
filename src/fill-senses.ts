/**
 * Relleno de traducciones ausentes. Existe porque el prefetch de la sesión de
 * estudio y el de la ingesta de texto hacían lo mismo en dos sitios con reglas
 * de `translationSource` distintas, y se habían desincronizado.
 *
 * Invariante que respetan ambos llamadores: la IA **añade**, nunca sobrescribe.
 * Una traducción escrita por una persona (o por otra fuente) gana siempre, así
 * que aquí sólo se fusiona el conjunto y sólo se toca la fila si algo nuevo
 * entró. Escribir siempre, sin comprobar, degradaba `translationSource` a un
 * valor arbitrario en cuanto el modelo devolvía algo ya presente.
 */

import { db } from "./db";
import type { LlmConfig } from "./llm";

/** Subconjunto de `Node` que hace falta aquí. `id` opcional porque Dexie lo asigna. */
export interface TranslatableNode {
  id?: number;
  lemma: string;
  kind: "word" | "phrase";
}

export interface FillOptions {
  /** `true` si la palabra se puede traducir ya. Se llama una vez por palabra. */
  claim?: (lemma: string) => boolean;
  /** Contraparte de `claim`. Se llama siempre, incluso si la traducción falla. */
  release?: (lemma: string) => void;
}

/**
 * Ids con la forma `[L001]` porque el prompt del traductor numera las entradas y
 * la reconciliación por conjunto depende de poder mapear la respuesta de vuelta
 * al nodo sin llevar el texto entero.
 */
const unitId = (nodeId: number) => `L${String(nodeId).padStart(4, "0")}`;

/** Quita lo ya traducido: preguntar por lo que ya sabemos sólo gasta tokens. */
async function collectMissing(
  nodes: TranslatableNode[],
  claim?: (lemma: string) => boolean,
): Promise<TranslatableNode[]> {
  const units: TranslatableNode[] = [];
  for (const node of nodes) {
    // Sin id no hay forma de volver del `[L001]` al nodo, así que no es traducible.
    if (node.id === undefined) continue;
    if (claim && !claim(node.lemma)) continue;
    const sense = await db.senses.where("nodeId").equals(node.id).first();
    if (sense && sense.translations.length > 0) continue;
    units.push(node);
  }
  return units;
}

/** Fusiona en una sola transacción: un fallo a medias deja la fila intacta. */
async function mergeTranslations(got: Map<string, string[]>): Promise<number> {
  let added = 0;
  await db.transaction("rw", db.senses, async () => {
    for (const [id, translations] of got) {
      const sense = await db.senses
        .where("nodeId")
        .equals(Number(id.slice(1)))
        .first();
      if (!sense) continue;
      const set = new Set(sense.translations);
      const before = set.size;
      for (const t of translations) set.add(t);
      if (set.size === before) continue;
      await db.senses.update(sense.id!, { translations: [...set], translationSource: "ai" });
      added += set.size - before;
    }
  });
  return added;
}

export async function fillMissingTranslations(
  llm: LlmConfig,
  targetLang: string,
  nodes: TranslatableNode[],
  opts: FillOptions = {},
): Promise<{ translated: number; added: number }> {
  const units = await collectMissing(nodes, opts.claim);
  if (!units.length || !llm.model) {
    for (const u of units) opts.release?.(u.lemma);
    return { translated: 0, added: 0 };
  }

  try {
    // Import diferido: translate.ts arrastra el cliente LLM completo y esta ruta
    // sólo se necesita cuando hay endpoint configurado.
    const { translateBatch } = await import("./translate");
    const got = await translateBatch(
      llm,
      units.map((u) => ({ id: unitId(u.id!), word: u.lemma, kind: u.kind })),
      targetLang,
    );
    const added = await mergeTranslations(got);
    return { translated: got.size, added };
  } finally {
    // Se libera incluso si `translateBatch` lanza: si no, un fallo transitorio
    // dejaría esas palabras bloqueadas para el resto de la sesión.
    for (const u of units) opts.release?.(u.lemma);
  }
}
