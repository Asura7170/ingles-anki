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
 * `sourceTexts` NO se borra: es lo único que queda de lo que pegaste y va en el
 * backup. Sin él no hay forma de recuperar el texto sin volver a pegarlo.
 *
 * Devuelve el recuento real para que el aviso diga la verdad.
 */
export async function deleteDeck(deck: Deck): Promise<{ words: number; kept: number }> {
  const ids = await deckNodeIds(deck);
  const sources = await db.sources.toArray();
  // Toda fila guardada ya tiene id (Dexie lo asigna), pero el tipo lo marca
  // opcional, así que se filtra en vez de usar `!` en 6 sitios.
  const mine = new Set(
    sources
      .filter((s) => belongsToDeck(s, deck))
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

  // TODO en una transacción. Con dos, un fallo entre medias dejaba el mazo
  // borrado y las palabras huérfanas para siempre — el mismo bug que motivationsó
  // este módulo, pero sólo bajo fallo, que es la forma que no se reproduce a
  // mano.
  await db.transaction("rw", db.tables, async () => {
    await db.sources
      .where("id")
      .anyOf([...mine])
      .delete();
    await db.decks.delete(deck.id!);
    await cascade(doomed);
  });
  scheduleAutoSave();

  return { words: doomed.length, kept };
}
