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
 * Ejecuta un borrado destructivo y convierte el fallo en un aviso.
 *
 * IndexedDB es compartido por todas las pestañas del mismo origen y esta app no
 * coordina entre ellas (ni `BroadcastChannel`, ni `navigator.locks`, ni
 * `versionchange`), así que un aborto de transacción es reachable en uso normal:
 * otra pestaña escribiendo, o el `scheduleAutoSave` de un borrado anterior
 * peleándose con este. Sin esto, `await deleteWords(...)` sin capturar deja al
 * usuario sin saber si se borró, y en dos sitios la interfaz ya había
 * avanzado como si sí.
 */
export async function runDelete<T>(
  op: () => Promise<T>,
  failMsg: string,
  notify: (msg: string) => void,
): Promise<T | null> {
  try {
    return await op();
  } catch (err) {
    notify(`${failMsg}: ${String(err)}`);
    return null;
  }
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
 * `shared` — el número de **mazos** que comparten con este una transcripción,
 * no el de transcripciones: si la comparten, no se puede borrar sin matar al
 * otro. Un mazo importado no tiene transcripción, así que siempre da 0.
 */
export async function deleteDeck(
  deck: Deck,
): Promise<{ words: number; kept: number; texts: number; shared: number }> {
  const res = await db.transaction("rw", db.tables, async () => {
    const ids = await deckNodeIds(deck);
    const sources = await db.sources.toArray();

    // Transcripciones que otro mazo todavía reclama — y cuántos mazos las
    // reclaman. Hace falta la intersección: un mazo importado no tiene
    // `sourceTextIds`, así que con la unión a secas cualquier mazo generado en la
    // biblioteca lo hacía pasar por compartido, y el aviso nombraba una
    // transcripción que no tenía. Y `holders` son mazos, no transcripciones: el
    // aviso dice "la comparten N mazos".
    const mineTexts = deck.sourceTextIds ?? [];
    const holders = new Set<number>();
    const sharedWithMe = new Set<number>();
    for (const d of await db.decks.toArray()) {
      if (d.id === deck.id) continue;
      // Sin filtrar por `kind`: `belongsToDeck` trata cualquier mazo no importado
      // por sus `sourceTextIds`, así que un `kind:"filter"` también contaría.
      const overlap = (d.sourceTextIds ?? []).filter((t) => mineTexts.includes(t));
      if (!overlap.length) continue;
      holders.add(d.id!);
      for (const t of overlap) sharedWithMe.add(t);
    }
    const ownTexts = new Set(mineTexts.filter((t) => !sharedWithMe.has(t)));

    const mine = new Set(
      sources
        .filter((s) => {
          if (!belongsToDeck(s, deck)) return false;
          // Fila de un mazo importado: nuestra sin más, ya que `belongsToDeck`
          // comparó `deckId`. El guard de `deckId` que hace `belongsToDeck`
          // (un mazo no importado no la reclama) es lo que impide que un mazo
          // generado se lleve las palabras de un importado.
          if (s.deckId !== undefined) return true;
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

    await db.sources
      .where("id")
      .anyOf([...mine])
      .delete();
    await db.decks.delete(deck.id!);
    await cascade(doomed);
    await db.sourceTexts.bulkDelete([...ownTexts]);
    return { words: doomed.length, kept, texts: ownTexts.size, shared: holders.size };
  });
  scheduleAutoSave();
  return res;
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
  // Las dos lecturas y el borrado en la misma transacción, y con `decks` dentro
  // del ámbito. Leer fuera convertía cada instantánea en una respuesta
  // distinta: una transcripción pegada que confirmase su mazo entre ambas
  // lecturas se borraba igualmente, y es texto que escribió el usuario sin copia
  // en ninguna parte. Mismo patrón que `deleteDeck`, misma razón.
  const n = await db.transaction("rw", db.decks, db.sourceTexts, async () => {
    const referenced = new Set<number>();
    for (const d of await db.decks.toArray()) {
      for (const t of d.sourceTextIds ?? []) referenced.add(t);
    }
    const orphans = (await db.sourceTexts.toArray()).filter((t) => !referenced.has(t.id!));
    if (!orphans.length) return 0;
    await db.sourceTexts.bulkDelete(orphans.map((t) => t.id!));
    return orphans.length;
  });
  // Sólo si hubo algo que borrar: el plan anterior salía antes por el `return 0`
  // y no programaba una copia de seguridad entera sobre una operación vacía.
  if (n) scheduleAutoSave();
  return n;
}
