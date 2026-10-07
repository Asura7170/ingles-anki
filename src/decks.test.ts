import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IDBFactory } from "fake-indexeddb";
import { db, type Deck } from "./db";
import { ingest, markSourceKnown, type IngestItem } from "./ingest";
import { allDeckStats, buildQueue, deckNodeIds, deckStats, type StudyItem } from "./decks";
import { deleteDeck } from "./purge";
import { review, retrievability, newCard } from "./srs";

/**
 * Un mazo es una QUERY sobre el pool de nodos, no un contenedor. Aquí se verifica
 * la consecuencia práctica: borrar o dejar de mirar un mazo no puede afectar al
 * SRS de la palabra, porque el SRS vive en el nodo.
 */

const NOW = Date.UTC(2026, 0, 15);
const day = 86_400_000;
/** Límite de nuevas holgado: estos tests miran el contenido, no el recorte. */
const LIM = 20;

const item = (lemma: string, extra: Partial<IngestItem> = {}): IngestItem => ({
  headword: lemma,
  lemma,
  kind: "word",
  ...extra,
});

const now = () => new Date().getTime();

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await db.delete();
  await db.open();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  db.close();
});

async function seedDeck(deckName: string, words: string[]) {
  const deckId = (await db.decks.add({ name: deckName, kind: "import", createdAt: NOW }))!;
  for (const w of words) {
    await ingest([item(w, { translations: [`tr-${w}`] })], {
      kind: "apkg",
      priority: 30,
      deckId,
      noteId: words.indexOf(w) + 1,
      level: "Book 1",
    });
  }
  return deckId;
}

describe("deckNodeIds", () => {
  it("sólo devuelve las palabras del deck", async () => {
    const a = await seedDeck("A", ["run", "study"]);
    await seedDeck("B", ["child"]);
    expect((await deckNodeIds({ name: "A", kind: "import", createdAt: NOW, id: a })!).length).toBe(
      2,
    );
  });

  it("deck vacío → sin ids", async () => {
    const id = (await db.decks.add({ name: "Vacío", kind: "import", createdAt: NOW }))!;
    expect(await deckNodeIds({ name: "Vacío", kind: "import", createdAt: NOW, id })).toEqual([]);
  });

  it("deck generado filtra por sourceText", async () => {
    const sourceTextId = (await db.sourceTexts.add({
      kind: "text",
      title: "T",
      body: "x",
      importedAt: NOW,
    }))!;
    const deckId = (await db.decks.add({
      name: "G",
      kind: "generated",
      sourceTextIds: [sourceTextId],
      createdAt: NOW,
    }))!;
    await ingest([item("run")], { kind: "text", priority: 20, sourceTextId });

    expect(
      await deckNodeIds({
        name: "G",
        kind: "generated",
        sourceTextIds: [sourceTextId],
        createdAt: NOW,
        id: deckId,
      }),
    ).toHaveLength(1);
  });
});

describe("allDeckStats", () => {
  it("cuenta known, learning, due y fresh", async () => {
    const deckId = await seedDeck("A", ["run", "study", "child"]);

    const s0 = await deckStats({ name: "A", kind: "import", createdAt: NOW, id: deckId });
    expect(s0).toMatchObject({ total: 3, known: 0, fresh: 3, due: 0, learning: 0 });

    // Estudiar una y marcarla conocida.
    const run = (await db.nodes.where("lemma").equals("run").first())!;
    await db.nodes.update(run.id!, { card: review(run.card, 3, NOW), due: NOW + day });
    await db.nodes.update(run.id!, { known: 1 });

    const s1 = await deckStats({ name: "A", kind: "import", createdAt: NOW, id: deckId });
    expect(s1.known).toBe(1);
    // La marcada como conocida sale del recuento de "sin conocer".
    expect(s1.total).toBe(3);
  });

  it("deck vacío devuelve ceros, no undefined", async () => {
    const id = (await db.decks.add({ name: "V", kind: "import", createdAt: NOW }))!;
    expect(await deckStats({ name: "V", kind: "import", createdAt: NOW, id })).toEqual({
      total: 0,
      known: 0,
      learning: 0,
      due: 0,
      fresh: 0,
    });
  });

  it("varios mazos de golpe, y una palabra compartida cuenta en los dos", async () => {
    const a = await seedDeck("A", ["run"]);
    const b = await seedDeck("B", ["run", "study"]);

    const all = await allDeckStats([
      { name: "A", kind: "import", createdAt: NOW, id: a },
      { name: "B", kind: "import", createdAt: NOW, id: b },
    ]);

    // Ésta es la razón de no haber `break` en el bucle interno: "run" tiene dos
    // filas en `sources` y pertenece a los dos mazos.
    expect(all.get(a!)!.total).toBe(1);
    expect(all.get(b!)!.total).toBe(2);
  });

  it("un mazo sin id no entra en el mapa", async () => {
    const out = await allDeckStats([{ name: "S", kind: "import", createdAt: NOW }]);
    expect(out.size).toBe(0);
  });

  it("lista vacía no lee la base", async () => {
    expect((await allDeckStats([])).size).toBe(0);
  });

  it("un mazo generado cuenta por sourceTextId, no por deckId", async () => {
    const sourceTextId = (await db.sourceTexts.add({
      kind: "text",
      title: "T",
      body: "x",
      importedAt: NOW,
    }))!;
    await ingest([item("run")], { kind: "text", priority: 20, sourceTextId });
    const g: Deck = {
      name: "G",
      kind: "generated",
      sourceTextIds: [sourceTextId],
      createdAt: NOW,
      id: 99,
    };

    expect((await allDeckStats([g])).get(99)!.total).toBe(1);
  });
});

describe("buildQueue — el límite de nuevas NO toca el SRS", () => {
  it("descarta las nuevas por encima del límite pero no las marca como repasadas", async () => {
    const deckId = await seedDeck("A", ["a1", "b1", "c1"]);
    const q = await buildQueue({ name: "A", kind: "import", createdAt: NOW, id: deckId }, 2, NOW);
    expect(q).toHaveLength(2);

    // La tercera sigue nueva: no se consumió un repaso por haberla limitado.
    const left = await db.nodes.where("lemma").equals("c1").first();
    expect(left!.card!.state).toBe(0);
  });

  it("el límite no descarta palabras ya en curso", async () => {
    const deckId = await seedDeck("A", ["a1", "b1", "c1"]);
    const a = (await db.nodes.where("lemma").equals("a1").first())!;
    await db.nodes.update(a.id!, { card: review(a.card, 3, NOW), due: NOW - 1 });

    const q = await buildQueue({ name: "A", kind: "import", createdAt: NOW, id: deckId }, 1, NOW);
    expect(q.map((i) => i.node.lemma)).toContain("a1");
  });
});

describe("buildQueue — las palabras conocidas no entran", () => {
  it("filtra `known` por completo", async () => {
    const deckId = await seedDeck("A", ["run", "study"]);
    await markSourceKnown((s) => s.deckId === deckId && s.noteId === 1);

    const q = await buildQueue(
      { name: "A", kind: "import" as const, createdAt: NOW, id: deckId },
      LIM,
    );
    expect(q.map((i) => i.node.lemma)).toEqual(["study"]);
  });
});

describe("buildQueue — orden por retrievability", () => {
  it("lo que se te está olvidando más va primero", async () => {
    const deckId = await seedDeck("A", ["solid", "frail"]);
    const solid = (await db.nodes.where("lemma").equals("solid").first())!;
    const frail = (await db.nodes.where("lemma").equals("frail").first())!;

    // Los repasos tienen que ser ANTERIORES al instante que consultamos: si
    // last_review está en el futuro, elapsed es negativo y R se clampa a 1.
    let sCard = review(solid.card, 4, NOW - 20 * day);
    sCard = review(sCard, 4, NOW - 10 * day);
    let fCard = review(frail.card, 3, NOW - 20 * day);
    fCard = review(fCard, 1, NOW - 10 * day);

    // Ambas vencidas hoy: el orden lo decide sólo la retencibilidad.
    await db.nodes.update(solid.id!, { card: sCard, due: NOW - 1 });
    await db.nodes.update(frail.id!, { card: fCard, due: NOW - 1 });

    expect(retrievability(fCard, NOW)).toBeLessThan(retrievability(sCard, NOW));

    const q = await buildQueue(
      { name: "A", kind: "import" as const, createdAt: NOW, id: deckId },
      LIM,
    );
    const order = q.map((i) => i.node.lemma);
    expect(order.indexOf("frail")).toBeLessThan(order.indexOf("solid"));
  });

  it("una palabra en Learning se ordena al final: su retencibilidad es 1", () => {
    // Consecuencia de ordenar por R: Learning siempre vale 1 y nunca es "lo que
    // más se me está olvidando". Documentado para que no parezca un bug.
    const learning = review(newCard(NOW), 3, NOW);
    expect(learning.state).toBe(1);
    expect(retrievability(learning, NOW)).toBe(1);
  });

  it("los repasos vencidos van antes que las nuevas", async () => {
    const deckId = await seedDeck("A", ["new1", "due1"]);
    const due = (await db.nodes.where("lemma").equals("due1").first())!;
    await db.nodes.update(due.id!, { card: review(due.card, 3, NOW), due: NOW - day });

    const q = await buildQueue(
      { name: "A", kind: "import" as const, createdAt: NOW, id: deckId },
      LIM,
    );
    expect(q.map((i) => i.node.lemma)).toEqual(["due1", "new1"]);
  });
});

describe("buildQueue — la frase más corta acompaña a la palabra", () => {
  it("elige el ejemplo con menos palabras", async () => {
    const deckId = await seedDeck("A", ["run"]);
    const node = (await db.nodes.where("lemma").equals("run").first())!;
    await db.examples.bulkAdd([
      {
        nodeId: node.id!,
        text: "The extraordinarily complicated administrative framework demands scrutiny.",
        sourceId: null,
      },
      { nodeId: node.id!, text: "They ran.", sourceId: null },
    ]);

    const q: StudyItem[] = await buildQueue(
      { name: "A", kind: "import", createdAt: NOW, id: deckId },
      LIM,
    );
    expect(q[0]!.sentence).toBe("They ran.");
  });

  it("palabra sin ejemplo → sentence undefined, no crash", async () => {
    const deckId = await seedDeck("A", ["run"]);
    const q = await buildQueue(
      { name: "A", kind: "import" as const, createdAt: NOW, id: deckId },
      LIM,
    );
    expect(q[0]!.sentence).toBeUndefined();
  });
});

describe("el SRS es global, no por deck", () => {
  it("una palabra en dos decks tiene un solo historial", async () => {
    const a = await seedDeck("A", ["run"]);
    const b = await seedDeck("B", ["run"]);
    expect(await db.nodes.count()).toBe(1);

    const node = (await db.nodes.where("lemma").equals("run").first())!;
    const card = review(node.card, 3, NOW);
    await db.nodes.update(node.id!, { card, due: NOW - 1 });

    // Dos sources distintas: la palabra está en los dos mazos.
    expect(await db.sources.filter((s) => s.deckId === a || s.deckId === b).count()).toBe(2);

    // Estudiar en A actualiza el nodo, y B ve exactamente ese mismo historial.
    const inB = await buildQueue(
      { name: "B", kind: "import" as const, createdAt: NOW, id: b },
      LIM,
    );
    expect(inB.map((i) => i.node.lemma)).toEqual(["run"]);
    expect(inB[0]!.node.card!.reps).toBe(1);
    expect(retrievability(inB[0]!.node.card, now())).toBeGreaterThan(0);
  });

  it("una palabra ya estudiada en A no reaparece en B hasta que venza", async () => {
    const a = await seedDeck("A", ["run"]);
    const b = await seedDeck("B", ["run"]);
    const node = (await db.nodes.where("lemma").equals("run").first())!;

    // Agendada 10 días por delante: el SRS es global, así que B tampoco la ve.
    const card = review(node.card, 3, NOW);
    await db.nodes.update(node.id!, { card, due: card.due.getTime() });

    expect(
      await buildQueue({ name: "A", kind: "import" as const, createdAt: NOW, id: a }, LIM),
    ).toHaveLength(0);
    expect(
      await buildQueue({ name: "B", kind: "import" as const, createdAt: NOW, id: b }, LIM),
    ).toHaveLength(0);
  });
});

describe("aislar un mazo no destruye progreso", () => {
  // Esta regla cambió: borrar un mazo borra sus palabras huérfanas. El SRS sigue
  // siendo global —lo que se conserva es la palabra compartida, no la del mazo
  // que se borra— pero "aislar un mazo" ya no es dejar la palabra intacta.
  // La cobertura de la regla nueva está en `purge.test.ts`.
  it("la palabra de otro mazo conserva su historial al borrar uno de los suyos", async () => {
    const a = await seedDeck("A", ["run"]);
    const b = await seedDeck("B", ["run"]);
    const node = (await db.nodes.where("lemma").equals("run").first())!;
    const card = review(node.card, 3, NOW);
    await db.nodes.update(node.id!, { card, due: card.due.getTime() });

    await deleteDeck({ name: "A", kind: "import", createdAt: NOW, id: a });

    // Sigue viva porque B también la tiene: un solo nodo, un solo historial.
    const after = await db.nodes.where("lemma").equals("run").first();
    expect(after!.card!.reps).toBe(1);
    expect(after!.due).toBe(card.due.getTime());
    expect(await db.sources.filter((s) => s.deckId === b).count()).toBe(1);
  });
});
