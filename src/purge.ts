/**
 * Borrado. Vive aquí y no en las vistas porque las dos necesitan la misma
 * cascada, y porque así se prueba en `environment: node` sin DOM.
 *
 * Invariante: un nodo sobrevive si le queda **alguna** fila en `sources` fuera
 * del mazo que se borra. Una palabra puede estar en varios mazos a la vez
 * (`decks.test.ts`: "una palabra en dos decks tiene un solo historial"), así que
 * borrar por `deckId → nodeId` se comería palabras de otros mazos. "Se queda
 * sin origen" es la definición de huérfano y no necesita saber nada del grafo.
 */

import { db, type Deck } from "./db";
import { belongsToDeck, deckNodeIds } from "./decks";
import { scheduleAutoSave } from "./backup";

/**
 * Cascada de borrado de una lista de nodos. Asume que ya hay una transacción
 * abierta: la comparten `deleteWords` y `deleteDeck` para que borrar un mazo sea
 * atómico.
 *
 * `reviewLog` sí se borra. La doctrina de "es la bitácora, nunca se borra"
 * (`srs.ts`) protege el historial de una palabra que *sigue existiendo* —
 * `unmark --reset` la respeta. Aquí el nodo desaparece, así que sus entradas no
 * describirían a nadie y sólo crecerían el backup.
 */
async function cascade(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await db.senses.where("nodeId").anyOf(ids).delete();
  await db.sources.where("nodeId").anyOf(ids).delete();
  await db.examples.where("nodeId").anyOf(ids).delete();
  await db.relations.where("fromNodeId").anyOf(ids).delete();
  await db.reviewLog.where("nodeId").anyOf(ids).delete();
  await db.exposure.where("nodeId").anyOf(ids).delete();
  await db.nodes.bulkDelete(ids);
}

/**
 * Borra palabras y todo lo que cuelga de ellas, en una transacción.
 */
export async function deleteWords(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  // `db.tables` y no la lista con nombre: la cascada toca 7 tablas y la
  // sobrecarga con tipado llega a 5. Anidarlas no vale — Dexie exige que la
  // transacción hija esté dentro de las tablas de la padre
  // ("SubTransactionError: Table examples not included in parent transaction").
  await db.transaction("rw", db.tables, () => cascade(ids));
  scheduleAutoSave();
  return ids.length;
}

/**
 * Borra un mazo y las palabras que le quedaban huérfanas.
 *
 * Sólo se borran las **no marcadas como conocidas**: la marca es un hecho sobre
 * ti, no sobre el import, así que sobrevive al mazo aunque la palabra se quede
 * sin ninguno. Consecuencia asumida: studied un mazo, no marcaste nada, y al
 * borrarlo pierdes también el historial de repaso.
 *
 * La transcripción SÍ se borra, junto al mazo que la creó. Es texto que
 * escribiste tú y que no está en ninguna otra parte salvo un backup que ya
 * tengas exportado; dejarla huérfana la convertía en basura inalcanzable, una
 * fila por cada ciclo pegar→borrar. `purgeOrphanTexts` limpia las que ya
 * quedaron.
 *
 * `exposure` no se toca: es un hecho sobre ti, como la marca `known`, así que
 * sobrevive a la transcripción. Deja una referencia colgante a un id que ya no
 * existe, inofensiva porque `++id` nunca reutiliza y la tabla no se lee en
 * ningún sitio.
 *
 * Devuelve el recuento real para que el aviso diga la verdad, incluido
 * `shared`: si una transcripción la comparten varios mazos, no se puede borrar
 * sin matar al otro (ver `ownsTexts`).
 */
export async function deleteDeck(
  deck: Deck,
): Promise<{ words: number; kept: number; texts: number; shared: number }> {
  const ids = await deckNodeIds(deck);
  const sources = await db.sources.toArray();

  // Transcripciones que otro mazo todavía reclama.
  const shared = new Set<number>();
  for (const d of await db.decks.toArray()) {
    if (d.id === deck.id) continue;
    // Sin filtrar por `kind`: `belongsToDeck` trata cualquier mazo no importado
    // por sus `sourceTextIds`, así que un `kind:"filter"` también contaría.
    for (const t of d.sourceTextIds ?? []) shared.add(t);
  }
  const ownTexts = new Set((deck.sourceTextIds ?? []).filter((t) => !shared.has(t)));

  const mine = new Set(
    sources
      .filter((s) => {
        if (!belongsToDeck(s, deck)) return false;
        // Una fila con `deckId` pertenece a un mazo importado por definición. Un
        // mazo no importado no puede reclamarla: si lo hiciera, borrar este
        // borraría las palabras de aquel. Sólo un backup restaurado a mano puede
        // producir una fila así — `importFromFile` no valida nada.
        if (s.deckId !== undefined) return deck.kind === "import";
        // Fila de transcripción: sólo si es nuestra en exclusiva.
        //
        // Y aquí está la costura crítica: si la transcripción se comparte,
        // `mine` tiene que quedar VACÍA para ese texto. No basta con saltarse
        // el `delete` más abajo, porque `mine` también decide qué palabras
        // quedan huérfanas — y un `mine` poblado volvería huérfanas las del
        // otro mazo, que es justo lo que hay que evitar.
        return ownTexts.has(s.sourceTextId ?? -1);
      })
      .flatMap((s) => (s.id === undefined ? [] : [s.id])),
  );

  // Una palabra sobrevive si le queda algún origen que no era de este mazo.
  const stillLinked = new Set<string>();
  for (const s of sources) if (!mine.has(s.id!)) stillLinked.add(String(s.nodeId));
  const orphans = ids.filter((id) => !stillLinked.has(String(id)));

  const doomed: number[] = [];
  let kept = 0;
  if (orphans.length) {
    for (const n of await db.nodes.where("id").anyOf(orphans).toArray()) {
      if (n.known) kept++;
      else doomed.push(n.id!);
    }
  }

  await db.transaction("rw", db.tables, async () => {
    await db.sources
      .where("id")
      .anyOf([...mine])
      .delete();
    await db.decks.delete(deck.id!);
    await cascade(doomed);
    for (const t of ownTexts) await db.sourceTexts.delete(t);
  });
  scheduleAutoSave();

  return { words: doomed.length, kept, texts: ownTexts.size, shared: shared.size };
}

/**
 * Borra transcripciones que ningún mazo reclama.
 *
 * NO hace cascada a las palabras, a propósito: borraría `reviewLog` —historial
 * de estudio— por una operación de limpieza de disco que el usuario no pidió, y
 * contradice la doctrina de `deleteDeck`, donde la marca `known` sobrevive al
 * borrado del mazo. Las palabras se quedan: pasan a mostrar "sin mazo", que es
 * distinto de "sin origen" pero no es pérdida de datos.
 */
export async function purgeOrphanTexts(): Promise<number> {
  const referenced = new Set<number>();
  for (const d of await db.decks.toArray()) {
    for (const t of d.sourceTextIds ?? []) referenced.add(t);
  }
  const orphans = (await db.sourceTexts.toArray()).filter((t) => !referenced.has(t.id!));
  if (!orphans.length) return 0;

  await db.transaction("rw", db.sourceTexts, async () => {
    for (const t of orphans) await db.sourceTexts.delete(t.id!);
  });
  scheduleAutoSave();
  return orphans.length;
}
