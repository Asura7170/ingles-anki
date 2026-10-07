import { db, type Deck, type Example, type Node } from "./db";
import { retrievability } from "./srs";

/** Un deck es una query sobre el pool de nodos. Nunca contiene cards. */

export interface StudyItem {
  node: Node;
  /** La frase más corta que contiene la palabra: menos ruido, mejor ancla. */
  sentence?: string;
}

export async function deckNodeIds(deck: Deck): Promise<number[]> {
  const sources = await db.sources.toArray();
  const relevant = sources.filter((s) => {
    if (deck.kind === "import") return s.deckId === deck.id;
    if (deck.sourceTextIds?.length) {
      return s.sourceTextId != null && deck.sourceTextIds.includes(s.sourceTextId);
    }
    return false;
  });
  return [...new Set(relevant.map((s) => s.nodeId))];
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

export async function deckStats(deck: Deck, now = Date.now()): Promise<DeckStats> {
  const ids = await deckNodeIds(deck);
  if (!ids.length) return { total: 0, known: 0, learning: 0, due: 0, fresh: 0 };

  const nodes = await db.nodes.where("id").anyOf(ids).toArray();
  const scoped = nodes.filter((n) => !deck.wordKinds || deck.wordKinds.includes(n.kind));
  const unseen = scoped.filter((n) => !n.known);

  return {
    total: scoped.length,
    known: scoped.length - unseen.length,
    learning: unseen.filter((n) => !isNew(n)).length,
    due: unseen.filter((n) => !isNew(n) && n.due <= now).length,
    fresh: unseen.filter(isNew).length,
  };
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
