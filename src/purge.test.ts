import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IDBFactory } from "fake-indexeddb";
import { db, type Deck } from "./db";
import { allDeckStats, buildQueue } from "./decks";
import { deleteDeck, deleteWords, purgeOrphanTexts, runDelete } from "./purge";
import { ingest, type IngestItem } from "./ingest";
import { newCard, review } from "./srs";

/**
 * El bug que motivó este módulo: al borrar un mazo creado desde «Pegar
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
    await db.media.add({
      nodeId: node.id!,
      name: "run.jpg",
      mime: "image/jpeg",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await db.exposure.add({ nodeId: node.id!, ts: NOW, occurrences: 3 });
    await db.reviewLog.add({ nodeId: node.id!, ts: NOW, ease: 3, source: "button" });
    await db.relations.add({ fromNodeId: node.id!, toWord: "runner", type: "collocation" });

    expect(await deleteWords([node.id!])).toBe(1);

    expect(await db.nodes.count()).toBe(0);
    expect(await db.senses.count()).toBe(0);
    expect(await db.sources.count()).toBe(0);
    expect(await db.examples.count()).toBe(0);
    // La imagen cuelga del nodo, no del source: si el nodo desaparece, nada la
    // reclama y quedarse sería basura permanente sin origen que la regenere.
    expect(await db.media.count()).toBe(0);
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

  it("se lleva la transcripción: queda huérfana e inalcanzable", async () => {
    const deck = await seedGenerated("Transcripción", ["run"]);
    const r = await deleteDeck(deck);

    // Antes sobraban una por ciclo pegar->borrar, y `sourceTexts` no tiene
    // ninguna pantalla donde verlas.
    expect(r.texts).toBe(1);
    expect(await db.sourceTexts.count()).toBe(0);
  });

  it("un mazo importado no toca ninguna transcripción", async () => {
    const sourceTextId = (await db.sourceTexts.add({
      kind: "text",
      title: "T",
      body: "x",
      importedAt: NOW,
    }))!;
    await ingest([item("run")], { kind: "text", priority: 20, sourceTextId });
    const imported = await seedDeck("A", ["study"]);

    const r = await deleteDeck(imported);
    expect(r.texts).toBe(0);
    expect(await db.sourceTexts.count()).toBe(1);
  });

  it("deja la exposición: es un hecho sobre ti, como la marca «conocida»", async () => {
    const deck = await seedGenerated("T", ["run"]);
    const node = (await db.nodes.where("lemma").equals("run").first())!;
    await db.nodes.update(node.id!, { known: 1 }); // sobrevive al mazo
    await db.exposure.add({ nodeId: node.id!, sourceTextId: 1, ts: NOW, occurrences: 4 });

    await deleteDeck(deck);

    expect(await db.sourceTexts.count()).toBe(0);
    expect(await db.nodes.count()).toBe(1);
    // Queda una referencia colgante al id borrado. Inofensiva: `++id` nunca
    // reutiliza y la tabla no se lee en ningún sitio del proyecto.
    expect(await db.exposure.count()).toBe(1);
  });
});

/**
 * El escenario que faltaba y que rompe la costura más fácil de arruinar.
 *
 * Un mazo generado se identifica por `sourceTextIds` y sus filas de `sources`
 * llevan `sourceTextId` pero NO `deckId`: no hay forma de saber cuál era de
 * cuál. Con dos mazos sobre la misma transcripción, `belongsToDeck` devuelve
 * `true` para las mismas filas en ambos, así que un `mine` poblado volvería
 * huérfanas las palabras del otro mazo y las borraría.
 */
describe("deleteDeck — transcripción compartida", () => {
  /** Dos mazos generados sobre el MISMO `sourceTextId`. */
  async function seedShared(): Promise<{ a: Deck; b: Deck; sourceTextId: number }> {
    const sourceTextId = (await db.sourceTexts.add({
      kind: "text",
      title: "Ch. 1",
      body: "run study child",
      importedAt: NOW,
    }))!;
    await ingest(["run", "study", "child"].map(item), {
      kind: "text",
      priority: 20,
      sourceTextId,
    });
    const aId = (await db.decks.add({
      name: "A",
      kind: "generated",
      sourceTextIds: [sourceTextId],
      createdAt: NOW,
    }))!;
    const bId = (await db.decks.add({
      name: "B",
      kind: "generated",
      sourceTextIds: [sourceTextId],
      createdAt: NOW + 1,
    }))!;
    return {
      a: { name: "A", kind: "generated", sourceTextIds: [sourceTextId], createdAt: NOW, id: aId },
      b: {
        name: "B",
        kind: "generated",
        sourceTextIds: [sourceTextId],
        createdAt: NOW + 1,
        id: bId,
      },
      sourceTextId,
    };
  }

  it("borrar uno NO deja sin palabras al otro", async () => {
    const { a, b } = await seedShared();
    expect(await db.nodes.count()).toBe(3);

    const r = await deleteDeck(a);

    expect(r.words).toBe(0);
    expect(r.kept).toBe(0);
    expect(r.shared).toBe(1);
    expect(await db.nodes.count()).toBe(3);
    expect(await db.sources.count()).toBe(3);
    // Y el otro mazo sigue teniendo su cola intacta.
    expect((await buildQueue(b, 20, NOW)).map((i) => i.node.lemma).sort()).toEqual([
      "child",
      "run",
      "study",
    ]);
  });

  it("NO borra la transcripción compartida", async () => {
    const { a, sourceTextId } = await seedShared();
    await deleteDeck(a);
    expect(await db.sourceTexts.count()).toBe(1);
    expect(await db.sourceTexts.get(sourceTextId)).toBeTruthy();
  });

  it("borra el mazo igualmente: sólo se salta la parte del texto", async () => {
    const { a, b } = await seedShared();
    await deleteDeck(a);
    expect(await db.decks.get(a.id!)).toBeUndefined();
    expect(await db.decks.get(b.id!)).toBeTruthy();
  });

  it("borrados los dos, la transcripción se va con el último", async () => {
    const { a, b } = await seedShared();
    await deleteDeck(a);
    expect(await db.sourceTexts.count()).toBe(1);

    await deleteDeck(b);
    // Con A ya no está, la transcripción es exclusiva de B: sus palabras quedan
    // huérfanas y se van con ella, que es la regla normal.
    expect(await db.sourceTexts.count()).toBe(0);
    expect(await db.nodes.count()).toBe(0);
  });

  it("una fila con deckId y sourceTextId a la vez no se roba", async () => {
    // Sólo un backup restaurado a mano puede producirla: `importFromFile` no
    // valida nada. Sin el filtro, el mazo generado se la atribuiría y al borrar
    // se llevaría las palabras del mazo importado.
    const generated = await seedGenerated("G", ["run"]);
    const imported = await seedDeck("I", ["study"]);
    await db.sources.add({
      nodeId: (await db.nodes.where("lemma").equals("study").first())!.id!,
      kind: "text",
      // La fila reclama los dos mazos a la vez.
      deckId: imported.id!,
      sourceTextId: generated.sourceTextIds![0]!,
      priority: 20,
      contentVersion: "x",
      addedAt: NOW,
    });

    const r = await deleteDeck(generated);

    // "study" sigue viva: la fila que reclama los dos mazos queda fuera de
    // `mine` por llevar `deckId`, así que cuenta como origen ajeno y no se
    // vuelve huérfana. Ese es el punto del filtro.
    expect(await db.nodes.where("lemma").equals("study").first()).toBeTruthy();
    // Y "run", que sólo existía por la transcripción de G, sí se va.
    expect(r.words).toBe(1);
    expect(await db.nodes.where("lemma").equals("run").first()).toBeUndefined();
  });
});

describe("purgeOrphanTexts", () => {
  it("borra las que no reclama ningún mazo", async () => {
    await db.sourceTexts.add({ kind: "text", title: "T", body: "x", importedAt: NOW });
    await db.sourceTexts.add({ kind: "text", title: "U", body: "y", importedAt: NOW + 1 });

    expect(await purgeOrphanTexts()).toBe(2);
    expect(await db.sourceTexts.count()).toBe(0);
  });

  it("respeta la que un mazo todavía usa", async () => {
    await seedGenerated("A", ["run"]);
    expect(await purgeOrphanTexts()).toBe(0);
    expect(await db.sourceTexts.count()).toBe(1);
  });

  it("NO borra palabras ni su historial", async () => {
    const deck = await seedGenerated("A", ["run"]);
    await db.nodes.update(1, { known: 1 });
    const card = review(newCard(NOW), 3, NOW - day);
    await db.nodes.update(1, { card, due: card.due.getTime() });
    await db.reviewLog.add({ nodeId: 1, ts: NOW, ease: 3, source: "button" });

    await purgeOrphanTexts();

    // Una limpieza de disco no puede borrar historial de estudio: contradice la
    // doctrina de `deleteDeck`, donde la marca `known` sobrevive al mazo.
    expect(await db.nodes.count()).toBe(1);
    expect(await db.reviewLog.count()).toBe(1);
    expect(await db.sources.count()).toBe(1);
    void deck;
  });

  it("sin huérfanas devuelve 0 y no toca nada", async () => {
    await seedGenerated("A", ["run"]);
    expect(await purgeOrphanTexts()).toBe(0);
    expect(await db.sourceTexts.count()).toBe(1);
  });

  it("deja limpia la que ya no reclama nadie tras borrar su mazo", async () => {
    const deck = await seedGenerated("A", ["run"]);
    await deleteDeck(deck);
    expect(await db.sourceTexts.count()).toBe(0);
  });
});

describe("deleteDeck — la regla de huérfanos", () => {
  it("una palabra compartida NO se borra al borrar uno de sus mazos", async () => {
    const a = await seedDeck("A", ["run"]);
    await seedDeck("B", ["run"]);
    expect(await db.nodes.count()).toBe(1);
    const node = (await db.nodes.where("lemma").equals("run").first())!;
    await db.media.add({
      nodeId: node.id!,
      name: "run.jpg",
      mime: "image/jpeg",
      bytes: new Uint8Array([1]),
    });

    const r = await deleteDeck(a);

    // Es el caso que un "sources.deckId → nodeId" ingenuo rompe: se comería la
    // palabra de B, que sigue teniendo su propia fila en `sources`.
    expect(r.words).toBe(0);
    expect(r.kept).toBe(0);
    expect(await db.nodes.count()).toBe(1);
    expect(await db.sources.count()).toBe(1);
    // La imagen es de la palabra, no del mazo: la palabra vive y la imagen con
    // ella. Sin este assert, un `media` colgado de `sources` pasaría la suite.
    expect(await db.media.count()).toBe(1);
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
    await db.media.add({
      nodeId: run.id!,
      name: "run.jpg",
      mime: "image/jpeg",
      bytes: new Uint8Array([1]),
    });

    const r = await deleteDeck(deck);

    expect(r.words).toBe(1);
    expect(r.kept).toBe(1);
    expect(await db.nodes.count()).toBe(1);
    const left = (await db.nodes.toArray())[0]!;
    expect(left.lemma).toBe("run");
    expect(left.known).toBe(1);
    // `known` protege todo lo suyo: la palabra queda "sin mazo" y su imagen
    // sigue con ella. Colgar `media` de `sources` la perdería aquí.
    expect(await db.media.count()).toBe(1);
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
    expect(r).toEqual({ words: 0, kept: 0, texts: 0, shared: 0 });
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
    expect(r).toEqual({ words: 2, kept: 1, texts: 0, shared: 0 });
  });
});

/**
 * `shared` cuenta MAZOS, no transcripciones, y sólo los que comparten una
 * transcripción con ÉSTE. Con la unión a secas de los `sourceTextIds` de todos
 * los demás, cualquier mazo generado en la biblioteca hacía pasar por
 * compartido a un mazo importado — que no tiene transcripción — y el aviso
 * nombraba texto y palabras que no existían, en el borrado más común del app.
 */
describe("deleteDeck — `shared` cuenta mazos, no transcripciones", () => {
  it("un mazo importado da 0 aunque haya mazos generados: no comparte nada", async () => {
    await seedGenerated("T", ["run"]);
    const imported = await seedDeck("A", ["study"]);

    const r = await deleteDeck(imported);

    expect(r.shared).toBe(0);
    expect(r.texts).toBe(0);
  });

  it("tres mazos sobre la misma transcripción dan 3, no 1", async () => {
    const sourceTextId = (await db.sourceTexts.add({
      kind: "text",
      title: "Ch. 1",
      body: "run",
      importedAt: NOW,
    }))!;
    await ingest([item("run")], { kind: "text", priority: 20, sourceTextId });
    const mk = (name: string, t: number) =>
      db.decks.add({ name, kind: "generated", sourceTextIds: [t], createdAt: t });
    await mk("A", sourceTextId);
    await mk("B", sourceTextId);
    await mk("C", sourceTextId);
    const a = await deckOf("A");

    expect((await deleteDeck(a)).shared).toBe(2);
  });

  it("un mazo con dos transcripciones cuenta una vez por mazo, no dos", async () => {
    const t1 = (await db.sourceTexts.add({
      kind: "text",
      title: "T1",
      body: "run",
      importedAt: NOW,
    }))!;
    const t2 = (await db.sourceTexts.add({
      kind: "text",
      title: "T2",
      body: "study",
      importedAt: NOW,
    }))!;
    await ingest([item("run"), item("study")], { kind: "text", priority: 20, sourceTextId: t1 });
    await ingest([item("study")], { kind: "text", priority: 20, sourceTextId: t2 });
    await db.decks.add({ name: "B", kind: "generated", sourceTextIds: [t1, t2], createdAt: NOW });
    await db.decks.add({
      name: "A",
      kind: "generated",
      sourceTextIds: [t1, t2],
      createdAt: NOW + 1,
    });

    // B comparte las dos transcripciones con A: es un mazo, no dos.
    expect((await deleteDeck(await deckOf("A"))).shared).toBe(1);
  });

  it("una transcripción que otro mazo tiene en exclusiva ajena no cuenta", async () => {
    await seedGenerated("Otro", ["child"]);
    const mine = await seedGenerated("Mío", ["run"]);

    expect((await deleteDeck(mine)).shared).toBe(0);
  });
});

/**
 * Una fila de `sources` puede llevar `deckId` Y `sourceTextId`: sólo un backup
 * restaurado a mano lo produce, porque `importFromFile` no valida nada. La regla
 * vive en `belongsToDeck` para que lectura y borrado no discrepen — antes la
 * lectura la contaba para el mazo generado y el borrado la destruía al borrar el
 * importado, así que tocar un mazo cambiaba la tarjeta de otro.
 */
describe("una fila con deckId y sourceTextId a la vez", () => {
  it("el mazo generado no la cuenta como suya al LEER", async () => {
    const generated = await seedGenerated("G", ["run"]);
    await seedDeck("I", ["study"]);
    const study = (await db.nodes.where("lemma").equals("study").first())!;
    await db.sources.add({
      nodeId: study.id!,
      kind: "text",
      deckId: (await deckOf("I")).id!,
      sourceTextId: generated.sourceTextIds![0]!,
      priority: 20,
      contentVersion: "x",
      addedAt: NOW,
    });

    // "run" es de G; "study" sólo tiene la fila dual, que es del importado.
    const stats = (await allDeckStats([generated])).get(generated.id!)!;
    expect(stats.total).toBe(1);
    // Y la cola de G tampoco la ofrece.
    expect((await buildQueue(generated, 20, NOW)).map((i) => i.node.lemma)).toEqual(["run"]);
  });

  it("borrar el importado deja la tarjeta y la cola del generado intactas", async () => {
    const generated = await seedGenerated("G", ["run"]);
    const imported = await seedDeck("I", ["study"]);
    const study = (await db.nodes.where("lemma").equals("study").first())!;
    await db.sources.add({
      nodeId: study.id!,
      kind: "text",
      deckId: imported.id!,
      sourceTextId: generated.sourceTextIds![0]!,
      priority: 20,
      contentVersion: "x",
      addedAt: NOW,
    });

    const antes = (await allDeckStats([generated])).get(generated.id!)!.total;
    await deleteDeck(imported);
    const despues = (await allDeckStats([generated])).get(generated.id!)!.total;

    // La fila dual es del importado (`deckId`), así que al borrarlo se va con él
    // y "study" queda huérfana y se borra: correcto, la tenía I. Lo que no puede
    // pasar es que la tarjeta de G cambie, y antes lo hacía porque la LEÍA como
    // propia: el usuario tocaba I y veía a G perder una palabra sin haber tocado
    // G. Con el guard de `deckId` en `belongsToDeck`, ni la cuenta antes ni
    // después.
    expect(antes).toBe(1);
    expect(despues).toBe(1);
    expect(await db.nodes.where("lemma").equals("study").first()).toBeUndefined();
    expect((await buildQueue(generated, 20, NOW)).map((i) => i.node.lemma)).toEqual(["run"]);
  });
});

describe("runDelete", () => {
  it("devuelve el valor si la operación va bien", async () => {
    expect(
      await runDelete(
        async () => 42,
        "fallo",
        () => {},
      ),
    ).toBe(42);
  });

  it("avisa y devuelve null si la operación lanza", async () => {
    const msgs: string[] = [];
    const r = await runDelete(
      async () => {
        throw new Error("boom");
      },
      "No se pudo borrar el mazo",
      (m) => msgs.push(m),
    );
    expect(r).toBeNull();
    expect(msgs).toEqual(["No se pudo borrar el mazo: Error: boom"]);
  });

  it("un null legítimo no se confunde con un fallo", async () => {
    expect(
      await runDelete(
        async () => null,
        "fallo",
        () => {},
      ),
    ).toBeNull();
  });
});

describe("buildQueue acota el límite de nuevas", () => {
  it("NaN o negativo no rompen la cola", async () => {
    const deck = await seedGenerated("T", ["a1", "a2", "a3"]);

    // `slice(0, NaN)` no daba nada y `slice(0, -1)` quitaba la última: un
    // backup editado a mano pasaba el límite sin comprobar por `getSetting`.
    expect((await buildQueue(deck, Number.NaN, NOW)).length).toBe(0);
    expect((await buildQueue(deck, -1, NOW)).length).toBe(0);
    expect((await buildQueue(deck, 2, NOW)).length).toBe(2);
  });
});

describe("deleteDeck es atómico", () => {
  it("si la cascada falla, no se borra el mazo", async () => {
    // Con dos transacciones, un fallo entre medias dejaba el mazo borrado y las
    // palabras huérfanas para siempre: el mismo bug que motivó el módulo,
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
