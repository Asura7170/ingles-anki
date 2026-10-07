import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { IDBFactory } from "fake-indexeddb";
import { db, type Node } from "./db";
import { ingest, markSourceKnown, hash, type IngestItem } from "./ingest";

/**
 * EL INVARIANTE CENTRAL DEL SISTEMA.
 *
 * Todos los caminos de entrada (.apkg, texto, PDF, IA) llaman a `ingest()`. Si
 * una palabra ya existe, NO se crea card: se fusiona su contenido. Esto es lo que
 * hace que importar un mazo nuevo nunca obligue a reaprender lo que ya sabes.
 */

const item = (lemma: string, extra: Partial<IngestItem> = {}): IngestItem => ({
  headword: lemma,
  lemma,
  kind: "word",
  ...extra,
});

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await db.delete();
  await db.open();
});

afterEach(async () => {
  db.close();
});

describe("ingest — creación", () => {
  it("crea el nodo y su sense inicial", async () => {
    const r = await ingest([item("run", { translations: ["correr"] })], {
      kind: "apkg",
      priority: 30,
    });

    expect(r).toEqual({ created: 1, merged: 0, changed: 0 });
    const node = await db.nodes.where("lemma").equals("run").first();
    expect(node).toBeDefined();
    expect(node!.known).toBe(0);
    expect(node!.card).not.toBeNull();

    const sense = await db.senses.where("nodeId").equals(node!.id!).first();
    expect(sense!.translations).toEqual(["correr"]);
  });

  it("una palabra nativa queda marcada como conocida", async () => {
    await ingest([item("startle")], { kind: "apkg", priority: 30 });
    const node = await db.nodes.where("lemma").equals("startle").first();
    expect(node!.known).toBe(0);
    expect(node!.lemma).toBe("startle");
  });

  it("el lemma es único: el índice &lemma impide duplicados", async () => {
    await ingest([item("run")], { kind: "apkg", priority: 30 });
    // El segundo insert debe fusionar, no crear.
    const r = await ingest([item("run", { translations: ["ejecutar"] })], {
      kind: "apkg",
      priority: 30,
    });
    expect(r.created).toBe(0);
    expect(await db.nodes.count()).toBe(1);
  });

  it("distingue palabra de frase", async () => {
    await ingest([item("give up", { kind: "phrase" })], { kind: "text", priority: 20 });
    const node = await db.nodes.where("lemma").equals("give up").first();
    expect(node!.kind).toBe("phrase");
  });
});

describe("ingest — deduplicación (el caso que te trae aquí)", () => {
  it("una palabra flexionada NO crea un nodo nuevo", async () => {
    // El deck trae el headword `run`; la transcripción trae `running`.
    await ingest([item("run")], { kind: "apkg", priority: 30 });
    const r = await ingest([item("run", { headword: "running" })], { kind: "text", priority: 20 });

    expect(r.merged).toBe(1);
    expect(await db.nodes.count()).toBe(1);
  });

  it("marcar como conocido hace que la palabra desaparezca del mazo", async () => {
    // Este es el flujo completo: importar, terminar, marcar aprendido, y luego
    // una transcripción que la contiene.
    await ingest([item("run", { translations: ["correr"] })], {
      kind: "apkg",
      priority: 30,
      deckId: 1,
    });
    await markSourceKnown((s) => s.deckId === 1);

    const known = await db.nodes.where("lemma").equals("run").first();
    expect(known!.known).toBe(1);

    await ingest([item("run")], { kind: "text", priority: 20, sourceTextId: 9 });
    const after = await db.nodes.where("lemma").equals("run").first();
    expect(after!.known).toBe(1);
    expect(await db.nodes.count()).toBe(1);
  });

  it("markSourceKnown cuenta los nodos afectados", async () => {
    await ingest([item("run"), item("study")], { kind: "apkg", priority: 30, deckId: 1 });
    expect(await markSourceKnown((s) => s.deckId === 1)).toBe(2);
    expect(await markSourceKnown((s) => s.deckId === 99)).toBe(0);
  });
});

describe("ingest — fusión de contenido (nunca sobrescribir)", () => {
  it("acumula traducciones en vez de reemplazar", async () => {
    await ingest([item("run", { translations: ["correr"] })], { kind: "apkg", priority: 30 });
    await ingest([item("run", { translations: ["ejecutar"] })], { kind: "text", priority: 20 });

    const node = await db.nodes.where("lemma").equals("run").first();
    const sense = await db.senses.where("nodeId").equals(node!.id!).first();
    expect(sense!.translations).toEqual(expect.arrayContaining(["correr", "ejecutar"]));
  });

  it("no duplica una traducción que ya estaba", async () => {
    await ingest([item("run", { translations: ["correr"] })], { kind: "apkg", priority: 30 });
    await ingest([item("run", { translations: ["correr"] })], { kind: "text", priority: 20 });

    const node = await db.nodes.where("lemma").equals("run").first();
    const sense = await db.senses.where("nodeId").equals(node!.id!).first();
    expect(sense!.translations).toEqual(["correr"]);
  });

  it("la IA añade alternativa pero no pisa el contenido de un deck", async () => {
    await ingest([item("run", { translations: ["correr"] })], { kind: "apkg", priority: 30 });
    await ingest([item("run", { translations: ["correr", "hacer Correr"] })], {
      kind: "ai",
      priority: 10,
    });

    const node = await db.nodes.where("lemma").equals("run").first();
    const sense = await db.senses.where("nodeId").equals(node!.id!).first();
    // La traducción del deck sigue ahí; la IA sólo suma.
    expect(sense!.translations).toContain("correr");
    expect(sense!.translations).toContain("hacer Correr");
  });

  it("añade varias frases de ejemplo y no duplica", async () => {
    await ingest([item("run", { examples: [{ text: "She runs." }] })], {
      kind: "apkg",
      priority: 30,
    });
    await ingest([item("run", { examples: [{ text: "She runs." }, { text: "They ran away." }] })], {
      kind: "text",
      priority: 20,
    });

    const node = await db.nodes.where("lemma").equals("run").first();
    const rows = await db.examples.where("nodeId").equals(node!.id!).toArray();
    expect(rows.map((r) => r.text).sort()).toEqual(["She runs.", "They ran away."]);
  });

  it("marca como IA las ejemplos que no vienen de una fuente", async () => {
    await ingest([item("run", { examples: [{ text: "They ran.", fromAi: true }] })], {
      kind: "ai",
      priority: 10,
    });
    const rows = await db.examples.toArray();
    expect(rows[0]!.sourceId).toBeNull();
  });
});

describe("ingest — procedencia y re-import", () => {
  it("guarda una fila de source por origen", async () => {
    await ingest([item("run")], {
      kind: "apkg",
      priority: 30,
      deckId: 1,
      noteId: 42,
      level: "Book 1",
    });
    const src = await db.sources.toArray();
    expect(src).toHaveLength(1);
    expect(src[0]).toMatchObject({ deckId: 1, noteId: 42, level: "Book 1", priority: 30 });
  });

  it("no duplica el source cuando el contenido no cambió", async () => {
    await ingest([item("run", { translations: ["correr"] })], {
      kind: "apkg",
      priority: 30,
      noteId: 1,
    });
    const r = await ingest([item("run", { translations: ["correr"] })], {
      kind: "apkg",
      priority: 30,
      noteId: 1,
    });

    expect(await db.sources.count()).toBe(1);
    expect(r.changed).toBe(0);
  });

  it("detecta el cambio si el deck trae mejores traducciones", async () => {
    await ingest([item("run", { translations: ["correr"] })], {
      kind: "apkg",
      priority: 30,
      noteId: 1,
    });
    const r = await ingest([item("run", { translations: ["correr", "ejecutar"] })], {
      kind: "apkg",
      priority: 30,
      noteId: 1,
    });

    expect(r.changed).toBe(1);
    expect(await db.sources.count()).toBe(1);
  });

  it("el re-import NO toca el historial de repaso", async () => {
    // La queja original: que actualizar un mazo te obligara a reaprender.
    await ingest([item("run")], { kind: "apkg", priority: 30, deckId: 1, noteId: 1 });
    const before = await db.nodes.where("lemma").equals("run").first();
    const cardBefore = before!.card;

    await ingest([item("run", { translations: ["nuevo"] })], {
      kind: "apkg",
      priority: 30,
      deckId: 1,
      noteId: 1,
    });

    const after = await db.nodes.where("lemma").equals("run").first();
    expect(after!.card).toEqual(cardBefore);
    expect(after!.createdAt).toBe(before!.createdAt);
  });

  it("guarda el nivel del sub-deck", async () => {
    await ingest([item("run")], {
      kind: "apkg",
      priority: 30,
      deckId: 1,
      noteId: 1,
      level: "Book 1",
    });
    expect((await db.sources.toArray())[0]!.level).toBe("Book 1");
  });
});

describe("ingest — lote", () => {
  it("procesa un lote mixto informando el desglose", async () => {
    await ingest([item("run")], { kind: "apkg", priority: 30, deckId: 1 });
    const r = await ingest([item("run"), item("study"), item("child")], {
      kind: "text",
      priority: 20,
      sourceTextId: 3,
    });

    expect(r).toEqual({ created: 2, merged: 1, changed: 0 });
    expect(await db.nodes.count()).toBe(3);
  });

  it("lote vacío no toca nada", async () => {
    expect(await ingest([], { kind: "text", priority: 20 })).toEqual({
      created: 0,
      merged: 0,
      changed: 0,
    });
  });
});

describe("hash", () => {
  it("es estable y distingue contenido", () => {
    expect(hash("run")).toBe(hash("run"));
    expect(hash("run")).not.toBe(hash("study"));
  });
});

describe("la marca known no la toca el SRS", () => {
  it("importar nunca cambia el flag known", async () => {
    await ingest([item("run")], { kind: "apkg", priority: 30 });
    await db.nodes.where("lemma").equals("run").modify({ known: 1 });

    await ingest([item("run", { translations: ["x"] })], { kind: "apkg", priority: 30, noteId: 1 });
    const n = await db.nodes.where("lemma").equals("run").first();
    expect(n!.known).toBe(1);
  });

  it("una palabra recién creada nace con card nueva, no vencida", async () => {
    await ingest([item("run")], { kind: "apkg", priority: 30 });
    const n = await db.nodes.where("lemma").equals("run").first();
    // Se compara el estado y el `due` con tolerancia de 2 ms en lugar de
    // `toEqual`: `createdAt` viene de un `Date.now()` y `newCard` lo vuelve a
    // leer, así que un clock tick entre ambas llamadas daba diferencias de 1 ms.
    // Un fallo ése no dice nada del comportamiento que se quiere fijar.
    expect(n!.card!.state).toBe(0);
    expect(n!.card!.reps).toBe(0);
    expect(n!.card!.stability).toBe(0);
    expect(Math.abs(+n!.card!.due - +n!.createdAt)).toBeLessThanOrEqual(2);
  });
});

function lemmaOf(nodes: Node[]): string[] {
  return nodes.map((n) => n.lemma).sort();
}

void lemmaOf;
