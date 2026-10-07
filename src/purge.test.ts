import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IDBFactory } from "fake-indexeddb";
import { db, type Deck } from "./db";
import { deleteDeck, deleteWords } from "./purge";
import { ingest, type IngestItem } from "./ingest";
import { newCard, review } from "./srs";

/**
 * El bug que motivationsó este módulo: al borrar un mazo creado desde «Pegar
 * transcripción», sus palabras seguían en la pestaña Palabras. Un mazo generado
 * se localiza por `sourceTextIds`, no por `deckId`, así que la regla anterior
 * (`sources.deckId === X`) no encontraba ninguna de sus palabras.
 *
 * Y el riesgo opuesto, que es el que justifica la regla de huérfanos: una
 * palabra puede estar en dos mazos a la vez, así que borrar por `deckId → nodeId`
 * se comería palabras de otro mazo.
 */

const NOW = Date.UTC(2026, 0, 15);
const day = 86_400_000;

const item = (lemma: string): IngestItem => ({
  headword: lemma,
  lemma,
  kind: "word",
  translations: [`tr-${lemma}`],
});

/** Mazo importado, el caso de `.apkg`. */
async function seedDeck(name: string, words: string[]): Promise<Deck> {
  const id = (await db.decks.add({ name, kind: "import", createdAt: NOW }))!;
  for (const w of words) {
    await ingest([item(w)], { kind: "apkg", priority: 30, deckId: id, noteId: 1, level: "B1" });
  }
  return { name, kind: "import", createdAt: NOW, id };
}

/** Mazo generado, el caso de «Pegar transcripción». */
async function seedGenerated(name: string, words: string[]): Promise<Deck> {
  const sourceTextId = (await db.sourceTexts.add({
    kind: "text",
    title: name,
    body: words.join(" "),
    importedAt: NOW,
  }))!;
  await ingest(words.map(item), { kind: "text", priority: 20, sourceTextId });
  const id = (await db.decks.add({
    name,
    kind: "generated",
    sourceTextIds: [sourceTextId],
    createdAt: NOW,
  }))!;
  return { name, kind: "generated", sourceTextIds: [sourceTextId], createdAt: NOW, id };
}

/** Por nombre: `decks` no tiene índice único sobre él, así que se filtra. */
const deckOf = async (name: string): Promise<Deck> =>
  (await db.decks.filter((d) => d.name === name).first())!;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await db.delete();
  await db.open();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("deleteWords", () => {
  it("borra la palabra y todo lo que cuelga de ella", async () => {
    await seedDeck("A", ["run"]);
    const node = (await db.nodes.where("lemma").equals("run").first())!;
    await db.senses
      .where("nodeId")
      .equals(node.id!)
      .modify({ translations: ["correr"] });
    await db.examples.add({ nodeId: node.id!, text: "They run.", sourceId: null });
    await db.exposure.add({ nodeId: node.id!, ts: NOW, occurrences: 3 });
    await db.reviewLog.add({ nodeId: node.id!, ts: NOW, ease: 3, source: "button" });
    await db.relations.add({ fromNodeId: node.id!, toWord: "runner", type: "collocation" });

    expect(await deleteWords([node.id!])).toBe(1);

    expect(await db.nodes.count()).toBe(0);
    expect(await db.senses.count()).toBe(0);
    expect(await db.sources.count()).toBe(0);
    expect(await db.examples.count()).toBe(0);
    expect(await db.exposure.count()).toBe(0);
    // La bitácora se va con la palabra: si el nodo desaparece, sus entradas no
    // describirían a nadie y sólo crecerían el backup.
    expect(await db.reviewLog.count()).toBe(0);
    expect(await db.relations.count()).toBe(0);
  });

  it("no toca otras palabras", async () => {
    await seedDeck("A", ["run", "study"]);
    const study = (await db.nodes.where("lemma").equals("study").first())!;
    const run = (await db.nodes.where("lemma").equals("run").first())!;
    await deleteWords([run.id!]);
    expect(await db.nodes.count()).toBe(1);
    expect(await db.nodes.get(study.id!)).toBeTruthy();
  });

  it("lista vacía es no-op y no lanza", async () => {
    await seedDeck("A", ["run"]);
    expect(await deleteWords([])).toBe(0);
    expect(await db.nodes.count()).toBe(1);
  });

  it("un id que no existe no rompe nada", async () => {
    await seedDeck("A", ["run"]);
    expect(await deleteWords([9999])).toBe(1);
    expect(await db.nodes.count()).toBe(1);
  });
});

describe("deleteDeck — el bug de los mazos generados", () => {
  it("borrar un mazo generado SÍ elimina sus palabras", async () => {
    const deck = await seedGenerated("Transcripción", ["run", "study", "child"]);
    expect(await db.nodes.count()).toBe(3);

    const r = await deleteDeck(deck);

    expect(r.words).toBe(3);
    expect(r.kept).toBe(0);
    expect(await db.nodes.count()).toBe(0);
    expect(await db.senses.count()).toBe(0);
    expect(await db.decks.count()).toBe(0);
  });

  it("borrar un mazo importado también elimina sus palabras", async () => {
    const deck = await seedDeck("A", ["run", "study"]);
    const r = await deleteDeck(deck);
    expect(r.words).toBe(2);
    expect(await db.nodes.count()).toBe(0);
  });

  it("no borra el texto guardado: es lo único que queda del original", async () => {
    const deck = await seedGenerated("Transcripción", ["run"]);
    await deleteDeck(deck);
    // Sin esto habría que volver a pegar la transcripción a mano.
    expect(await db.sourceTexts.count()).toBe(1);
  });
});

describe("deleteDeck — la regla de huérfanos", () => {
  it("una palabra compartida NO se borra al borrar uno de sus mazos", async () => {
    const a = await seedDeck("A", ["run"]);
    await seedDeck("B", ["run"]);
    expect(await db.nodes.count()).toBe(1);

    const r = await deleteDeck(a);

    // Es el caso que un "sources.deckId → nodeId" ingenuo rompe: se comería la
    // palabra de B, que sigue teniendo su propia fila en `sources`.
    expect(r.words).toBe(0);
    expect(r.kept).toBe(0);
    expect(await db.nodes.count()).toBe(1);
    expect(await db.sources.count()).toBe(1);
  });

  it("comparte entre generado e importado: sobrevive", async () => {
    const a = await seedDeck("A", ["run"]);
    const g = await seedGenerated("T", ["run"]);

    expect(await deleteDeck(a).then((r) => r.words)).toBe(0);
    expect(await db.nodes.count()).toBe(1);

    // Y ahora al revés: queda huérfana y sí se va.
    expect((await deleteDeck(g)).words).toBe(1);
    expect(await db.nodes.count()).toBe(0);
  });

  it("una palabra marcada como conocida se conserva aunque quede huérfana", async () => {
    const deck = await seedDeck("A", ["run", "study"]);
    const run = (await db.nodes.where("lemma").equals("run").first())!;
    await db.nodes.update(run.id!, { known: 1 });

    const r = await deleteDeck(deck);

    expect(r.words).toBe(1);
    expect(r.kept).toBe(1);
    expect(await db.nodes.count()).toBe(1);
    const left = (await db.nodes.toArray())[0]!;
    expect(left.lemma).toBe("run");
    expect(left.known).toBe(1);
  });

  it("lo único que sobrevive son las marcadas, aunque tengan historial", async () => {
    const deck = await seedDeck("A", ["run"]);
    const run = (await db.nodes.where("lemma").equals("run").first())!;
    // Historial real, sin marcar. Consecuencia asumida de la regla elegida: se
    // borra y se pierde el historial. El test lo fija para que nadie lo descubra
    // como una sorpresa.
    const card = review(newCard(NOW), 3, NOW - day);
    await db.nodes.update(run.id!, { card, due: card.due.getTime() });
    await db.reviewLog.add({ nodeId: run.id!, ts: NOW, ease: 3, source: "button" });

    const r = await deleteDeck(deck);

    expect(r.words).toBe(1);
    expect(r.kept).toBe(0);
    expect(await db.nodes.count()).toBe(0);
    expect(await db.reviewLog.count()).toBe(0);
  });
});

describe("deleteDeck — casos sin palabras", () => {
  it("mazo vacío borra 0 y sólo se va él mismo", async () => {
    const id = (await db.decks.add({ name: "Vacío", kind: "import", createdAt: NOW }))!;
    const r = await deleteDeck({ name: "Vacío", kind: "import", createdAt: NOW, id });
    expect(r).toEqual({ words: 0, kept: 0 });
    expect(await db.decks.count()).toBe(0);
  });

  it("sin kind 'import' ni sourceTextIds no puede saber qué es suyo: borra 0", async () => {
    await seedDeck("A", ["run"]);
    const id = (await deckOf("A")).id!;
    const r = await deleteDeck({ name: "A", kind: "filter", createdAt: NOW, id });
    expect(r.words).toBe(0);
    expect(await db.nodes.count()).toBe(1);
  });

  it("no toca los otros mazos", async () => {
    const a = await seedDeck("A", ["run"]);
    await seedDeck("B", ["study"]);

    await deleteDeck(a);

    expect(await db.decks.count()).toBe(1);
    expect((await deckOf("B")).name).toBe("B");
    expect(await db.nodes.count()).toBe(1);
  });

  it("devuelve el recuento real, que es lo que muestra el aviso", async () => {
    const deck = await seedDeck("A", ["a1", "b1", "c1"]);
    await db.nodes.update(1, { known: 1 });
    const r = await deleteDeck(deck);
    expect(r).toEqual({ words: 2, kept: 1 });
  });
});

describe("deleteDeck es atómico", () => {
  it("si la cascada falla, no se borra el mazo", async () => {
    // Con dos transacciones, un fallo entre medias dejaba el mazo borrado y las
    // palabras huérfanas para siempre: el mismo bug que motivationsó el módulo,
    // pero sólo bajo fallo — que es la forma que no se reproduce a mano.
    const deck = await seedDeck("A", ["run", "study"]);
    expect(await db.nodes.count()).toBe(2);

    // Se rompe `relations`, que está en medio de la cascada: senses y sources ya
    // se han borrado cuando salta. Se sabota `where` y no `delete` porque la
    // cascada llama a `Table.where(...).delete()`, y `delete` vive en la
    // Collection, no en la Table.
    vi.spyOn(db.relations, "where").mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(deleteDeck(deck)).rejects.toThrow("boom");
    vi.restoreAllMocks();

    // Todo o nada: el mazo sigue y las palabras siguen.
    expect(await db.decks.get(deck.id!)).toBeTruthy();
    expect(await db.nodes.count()).toBe(2);
    expect(await db.senses.count()).toBe(2);
    expect(await db.sources.count()).toBe(2);
  });
});
