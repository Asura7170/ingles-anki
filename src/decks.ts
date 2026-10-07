import { db, type Deck, type Example, type Node, type Source } from "./db";
import { retrievability } from "./srs";

/** Un deck es una query sobre el pool de nodos. Nunca contiene cards. */

export interface StudyItem {
  node: Node;
  /** La frase más corta que contiene la palabra: menos ruido, mejor ancla. */
  sentence?: string;
}

/**
 * ¿De qué mazo es esta palabra? Un mazo importado se localiza por `deckId`; uno
 * generado, por el `sourceTextId` que guarda en `sourceTextIds`. Exportado para
 * que el borrado use el mismo criterio que la lectura: duplicar esta regla era
 * la forma más corta de que "borrar un mazo" no encontrara sus propias palabras.
 */
export function belongsToDeck(source: Source, deck: Deck): boolean {
  if (deck.kind === "import") return source.deckId === deck.id;
  if (deck.sourceTextIds?.length) {
    return source.sourceTextId != null && deck.sourceTextIds.includes(source.sourceTextId);
  }
  return false;
}

export async function deckNodeIds(deck: Deck): Promise<number[]> {
  const sources = await db.sources.toArray();
  return [...new Set(sources.filter((s) => belongsToDeck(s, deck)).map((s) => s.nodeId))];
}

export interface DeckStats {
  total: number;
  known: number;
  learning: number;
  due: number;
  fresh: number;
}

/** Una palabra es "nueva" si FSRS nunca la ha visto: sin card o en estado New. */
const isNew = (n: Node) => !n.card || n.card.state === 0;

const EMPTY_STATS: DeckStats = { total: 0, known: 0, learning: 0, due: 0, fresh: 0 };

/** Recuento de una lista de nodos ya filtrada por `wordKinds`. */
function countStats(nodes: Node[], now: number): DeckStats {
  const unseen = nodes.filter((n) => !n.known);
  return {
    total: nodes.length,
    known: nodes.length - unseen.length,
    learning: unseen.filter((n) => !isNew(n)).length,
    due: unseen.filter((n) => !isNew(n) && n.due <= now).length,
    fresh: unseen.filter(isNew).length,
  };
}

/**
 * Estadísticas de todos los mazos con DOS lecturas: una de `sources` y otra de
 * `nodes`. Antes cada `DeckCard` abría su propio `useLiveQuery`, así que con 20
 * mazos había 20 escaneos completos de `sources` y 20 suscripciones vivas que
 * se relanzaban en cada cambio de un nodo.
 *
 * Una fuente puede pertenecer a varios mazos a la vez, y por eso no hay `break`
 * en el bucle interno: se añade a todos los que le corresponden.
 */
export async function allDeckStats(
  decks: Deck[],
  now = Date.now(),
): Promise<Map<number, DeckStats>> {
  const out = new Map<number, DeckStats>();
  for (const d of decks) if (d.id !== undefined) out.set(d.id, EMPTY_STATS);
  if (!decks.length) return out;

  const idsByDeck = new Map<number, Set<number>>();
  for (const s of await db.sources.toArray()) {
    for (const d of decks) {
      if (d.id === undefined || !belongsToDeck(s, d)) continue;
      const set = idsByDeck.get(d.id) ?? new Set<number>();
      set.add(s.nodeId);
      idsByDeck.set(d.id, set);
    }
  }

  const wanted = [...new Set([...idsByDeck.values()].flatMap((s) => [...s]))];
  const nodes = wanted.length ? await db.nodes.where("id").anyOf(wanted).toArray() : [];
  const byId = new Map(nodes.map((n) => [n.id!, n]));

  for (const [deckId, set] of idsByDeck) {
    const deck = decks.find((d) => d.id === deckId)!;
    const scoped = [...set]
      .map((id) => byId.get(id))
      .filter((n): n is Node => n !== undefined)
      .filter((n) => !deck.wordKinds || deck.wordKinds.includes(n.kind));
    out.set(deckId, countStats(scoped, now));
  }
  return out;
}

/** Azúcar sobre `allDeckStats` para cuando sólo interesa un mazo (tests, CLI). */
export async function deckStats(deck: Deck, now = Date.now()): Promise<DeckStats> {
  if (deck.id === undefined) return EMPTY_STATS;
  return (await allDeckStats([deck], now)).get(deck.id) ?? EMPTY_STATS;
}

/**
 * Cola de sesión: repasos vencidos primero ordenados por retrievability
 * ascendente ("lo que más se me está olvidando"), después las nuevas limitadas
 * por `newLimit`. El límite NO toca el SRS: sólo difiere las nuevas.
 *
 * El límite viene como parámetro y no como campo del mazo a propósito: es una
 * preferencia global (Ajustes), y leerlo de dos sitios fue un bug: la tarjeta
 * contaba con `deck.dailyNewLimit` mientras `startSession` sobrescribía con
 * `prefs.dailyNewLimit`, así que el botón prometía una cola que no llegaba.
 */
export async function buildQueue(
  deck: Deck,
  newLimit: number,
  now = Date.now(),
): Promise<StudyItem[]> {
  const ids = await deckNodeIds(deck);
  if (!ids.length) return [];

  const nodes = await db.nodes.where("id").anyOf(ids).toArray();
  const eligible = nodes.filter(
    (n) => !n.known && (!deck.wordKinds || deck.wordKinds.includes(n.kind)),
  );

  const reviews = eligible
    .filter((n) => !isNew(n) && n.due <= now)
    .sort((a, b) => retrievability(a.card, now) - retrievability(b.card, now));

  const fresh = eligible.filter(isNew).slice(0, newLimit);
  const queue = [...reviews, ...fresh];

  const rows = queue.length
    ? await db.examples
        .where("nodeId")
        .anyOf(queue.map((n) => n.id!))
        .toArray()
    : [];
  const byNode = new Map<number, Example[]>();
  for (const row of rows) {
    const list = byNode.get(row.nodeId);
    if (list) list.push(row);
    else byNode.set(row.nodeId, [row]);
  }

  return queue.map((node) => {
    const list = (byNode.get(node.id!) ?? []).sort(
      (a, b) => a.text.split(/\s+/).length - b.text.split(/\s+/).length,
    );
    return { node, sentence: list[0]?.text };
  });
}
