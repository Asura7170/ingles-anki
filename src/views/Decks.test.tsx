// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "../db";
import { ingest, type IngestItem } from "../ingest";
import { newCard, review } from "../srs";
import { useApp } from "../store";
import Decks from "./Decks";

/**
 * `DeckCard` era la función con peor CRAP del repo (CC 16, 0 %) y su CC es casi
 * todo `??` y `?.` en JSX: refactorizarla sería hacer el código peor para
 * contentar una métrica. Lo que sí baja el número es ejecutarla.
 *
 * Estos tests fijan sobre todo el contrato que la UI promete al usuario, que es
 * donde estaba el bug real:
 *
 *   - el número del botón tiene que ser la longitud exacta de la cola que
 *     `startSession` va a construir, con el límite de Ajustes;
 *   - borrar un mazo no puede tocar ni una palabra, porque el SRS vive en el
 *     nodo. Un test que sólo comprobara "el botón existe" passaría igual con el
 *     `db.nodes.clear()` debajo.
 *
 * Cero mocks: store real contra IndexedDB.
 */

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const item = (lemma: string): IngestItem => ({
  headword: lemma,
  lemma,
  kind: "word",
  translations: [`tr-${lemma}`],
});

/** Crea un mazo con sus palabras y devuelve su id. */
async function seedDeck(name: string, words: string[], createdAt = NOW): Promise<number> {
  const id = (await db.decks.add({ name, kind: "import", createdAt }))!;
  for (const w of words) {
    await ingest([item(w)], { kind: "apkg", priority: 30, deckId: id, noteId: 1, level: "Book 1" });
  }
  return id;
}

/**
 * Marca las primeras `count` palabras como ya repasadas y vencidas.
 *
 * `review()` y no un objeto literal: `card.due` es un `Date` en ts-fsrs, y
 * poner un número ahí revienta con `FSRSValidationError: Invalid date` en
 * cuanto `retrievability()` lo toca. El `due` del nodo sí es un número.
 */
async function markDue(count: number): Promise<void> {
  const rows = await db.nodes.limit(count).toArray();
  for (const n of rows) {
    const card = review(newCard(NOW), 3, NOW - DAY);
    await db.nodes.update(n.id!, { card, due: NOW - DAY });
  }
}

/**
 * El botón de confirmación destructivo. Antes decía siempre "¿Seguro? Borrar";
 * ahora incluye cuántas palabras se van, así que se busca por patrón y el
 * recuento se comprueba en sus propios tests.
 */
const CONFIRM = /^\u00bfSeguro\?/;

function setNewLimit(n: number): void {
  useApp.setState((s) => ({ prefs: { ...s.prefs, dailyNewLimit: n } }));
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await db.delete();
  await db.open();
  /**
   * `ingest()` llama a `loadFrequency()`, que hace `fetch("/frequency.json")`.
   * En happy-dom la URL relativa se resuelve contra el base del documento
   * (`http://localhost:3000`), así que node intenta conectar y vitest reporta un
   * `AggregateError` aunque el `catch` de `loadFrequency` lo silencie. En
   * `environment: node` no pasa: `fetch` revienta al parsear la URL, antes de
   * tocar la red. Por eso este fichero es el primero que lo sufre: es el primero
   * con DOM que llama a `ingest`.
   */
  function stubFetch(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
  }

  // Sólo la fecha, no `useFakeTimers`: fake-indexeddb se apoya en
  // setImmediate/queueMicrotask y los temporizadores falsos las dejan
  // incumplidas ("TransactionInactiveError"). Mismo truco que decks.test.ts.
  vi.setSystemTime(NOW);
  stubFetch();
  setNewLimit(20);
  useApp.setState({ busy: null, toast: null, deck: null, queue: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useApp.setState({ busy: null, toast: null });
});

describe("estado vacío", () => {
  it("explica qué es un mazo y cómo crear el primero", async () => {
    render(<Decks />);
    expect(screen.getByRole("heading", { name: "Mazos" })).toBeTruthy();
    expect(screen.getByText(/no un contenedor/)).toBeTruthy();
    expect(screen.getByText(/Todavía no hay mazos/)).toBeTruthy();
  });

  it("no ofrece botón de estudiar sin mazos", async () => {
    render(<Decks />);
    expect(screen.queryByRole("button", { name: /Estudiar/ })).toBeNull();
  });
});

describe("las estadísticas de cada mazo", () => {
  it("total, conocidas y el desglose", async () => {
    await seedDeck("A", ["run", "study", "child"]);
    render(<Decks />);

    await waitFor(() => expect(screen.getByText(/3 palabras · 0 conocidas/)).toBeTruthy());
    const panel = document.querySelector(".panel")!;
    // Un contador por categoría, con su etiqueta.
    expect(panel.textContent).toContain("Vencidas");
    expect(panel.textContent).toContain("Nuevas");
    expect(panel.textContent).toContain("En curso");
  });

  it("el botón cuenta vencidas + nuevas hasta el límite", async () => {
    await seedDeck("A", ["a1", "a2", "a3", "a4", "a5"]);
    setNewLimit(2);
    render(<Decks />);

    // 5 nuevas, límite 2 → promete 2, no 5 y no 0.
    await waitFor(() => expect(screen.getByRole("button", { name: "Estudiar 2" })).toBeTruthy());
  });

  it("sin nada pendiente, el botón se desactiva", async () => {
    await seedDeck("A", ["a1"]);
    await markDue(1);
    render(<Decks />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Estudiar/ })).toHaveProperty("disabled", true),
    );
  });
});

describe("el número del botón es la cola real", () => {
  it("coincide con lo que studySession construye, no con las nuevas totales", async () => {
    // 4 vencidas + 6 nuevas, límite 3 → 7, no 10.
    await seedDeck("A", ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"]);
    await markDue(4);
    setNewLimit(3);

    render(<Decks />);
    const button = await screen.findByRole("button", { name: "Estudiar 7" });

    fireEvent.click(button);
    await waitFor(() => expect(useApp.getState().queue).toHaveLength(7));
  });

  it("cambia al cambiar el límite de Ajustes, sin recargar", async () => {
    await seedDeck("A", ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
    render(<Decks />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Estudiar 8" })).toBeTruthy());

    setNewLimit(2);
    await waitFor(() => expect(screen.getByRole("button", { name: "Estudiar 2" })).toBeTruthy());
  });

  it("pulsaos arranca la sesión con ese mazo", async () => {
    const id = await seedDeck("A", ["run"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Estudiar 1" }));
    await waitFor(() => expect(useApp.getState().deck?.id).toBe(id));
    expect(useApp.getState().queue.map((i) => i.node.lemma)).toEqual(["run"]);
  });
});

describe("renombrar", () => {
  it("escribe el nombre nuevo en la base y avisa", async () => {
    const id = await seedDeck("Old", ["run"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Renombrar" }));
    const field = screen.getByLabelText("Nuevo nombre para Old");
    fireEvent.change(field, { target: { value: "Verbos irregulares" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(async () => expect((await db.decks.get(id))!.name).toBe("Verbos irregulares"));
    // El aviso vive en `toast`, que lo pinta `App`, no esta vista.
    expect(useApp.getState().toast).toBe("Mazo renombrado a «Verbos irregulares».");
  });

  it("el campo se cierra y el nombre nuevo queda a la vista", async () => {
    await seedDeck("Old", ["run"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Renombrar" }));
    const field = screen.getByLabelText("Nuevo nombre para Old");
    fireEvent.change(field, { target: { value: "Nuevo" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(await screen.findByText("Nuevo")).toBeTruthy();
    expect(screen.queryByLabelText("Nuevo nombre para Old")).toBeNull();
    // Y el botón de renombrar vuelve a estar disponible.
    expect(screen.getByRole("button", { name: "Renombrar" })).toBeTruthy();
  });

  it("un nombre vacío no borra la identidad del mazo", async () => {
    const id = await seedDeck("Old", ["run"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Renombrar" }));
    const field = screen.getByLabelText("Nuevo nombre para Old");
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(screen.queryByLabelText("Nuevo nombre para Old")).toBeNull());
    expect((await db.decks.get(id))!.name).toBe("Old");
  });

  it("Escape cancela sin escribir", async () => {
    const id = await seedDeck("Old", ["run"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Renombrar" }));
    const field = screen.getByLabelText("Nuevo nombre para Old");
    fireEvent.change(field, { target: { value: "No" } });
    fireEvent.keyDown(field, { key: "Escape" });

    await waitFor(() => expect(screen.queryByLabelText("Nuevo nombre para Old")).toBeNull());
    expect((await db.decks.get(id))!.name).toBe("Old");
  });
});

describe("borrar", () => {
  it("pide confirmación antes de hacer nada", async () => {
    const id = await seedDeck("A", ["run"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Borrar" }));
    // Primeiro click: sólo cambia el botón. La base está intacta.
    expect(screen.getByRole("button", { name: CONFIRM })).toBeTruthy();
    expect(await db.decks.get(id)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));
    // El botón se esconde al pulsar; el borrado real termina después, en la
    // transacción. Por eso la aserción va sobre la base, no sobre la UI.
    await waitFor(async () => expect(await db.decks.get(id)).toBeUndefined());
    expect(screen.queryByRole("button", { name: CONFIRM })).toBeNull();
  });

  it("la confirmación dice cuántas palabras se van", async () => {
    // Sin el número, "Borrar" sobre un mazo de 2.000 palabras es un borrado a
    // ciegas: no hay forma de saber qué está en juego antes de confirmar.
    await seedDeck("A", ["a1", "a2", "a3"]);
    render(<Decks />);

    // `doomed` sale de las estadísticas, que llegan por `useLiveQuery`. Antes de
    // que carguen el botón dice "¿Seguro? Borrar mazo" sin número, así que sin
    // esta espera el test probaría el estado de carga y no el de borrado.
    await screen.findByText(/3 palabras/);
    fireEvent.click(screen.getByRole("button", { name: "Borrar" }));
    expect(screen.getByRole("button", { name: "¿Seguro? Borrar mazo, 3 palabras" })).toBeTruthy();
  });

  it("no cuenta como eliminables las palabras marcadas como conocidas", async () => {
    await seedDeck("A", ["a1", "a2", "a3"]);
    await db.nodes.update(1, { known: 1 });
    render(<Decks />);

    await screen.findByText(/3 palabras/);
    fireEvent.click(screen.getByRole("button", { name: "Borrar" }));
    // Es un máximo, no una promesa: las compartidas con otro mazo sobreviven.
    expect(screen.getByRole("button", { name: "¿Seguro? Borrar mazo, 2 palabras" })).toBeTruthy();
  });

  it("la confirmación nombra la transcripción sólo si el mazo tiene una", async () => {
    // Nombrarla en un mazo importado sería mentir: no tiene transcripción.
    await seedDeck("A", ["a1", "a2"]);
    render(<Decks />);
    await screen.findByText(/2 palabras/);
    fireEvent.click(screen.getByRole("button", { name: "Borrar" }));
    expect(screen.getByRole("button", { name: "¿Seguro? Borrar mazo, 2 palabras" })).toBeTruthy();
  });

  it("un mazo generado nombra la transcripción: es texto que no queda en el backup", async () => {
    const sourceTextId = (await db.sourceTexts.add({
      kind: "text",
      title: "Ch. 1",
      body: "a1 a2",
      importedAt: NOW,
    }))!;
    await ingest(["a1", "a2"].map(item), { kind: "text", priority: 20, sourceTextId });
    await db.decks.add({
      name: "T",
      kind: "generated",
      sourceTextIds: [sourceTextId],
      createdAt: NOW,
    });
    render(<Decks />);

    await screen.findByText(/2 palabras/);
    fireEvent.click(screen.getByRole("button", { name: "Borrar" }));
    expect(
      screen.getByRole("button", { name: "¿Seguro? Borrar mazo, 2 palabras y la transcripción" }),
    ).toBeTruthy();
  });

  it("sin palabras que borrar, la confirmación no inventa un número", async () => {
    const id = (await db.decks.add({ name: "Vacío", kind: "import", createdAt: NOW }))!;
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Borrar" }));
    expect(screen.getByRole("button", { name: "¿Seguro? Borrar mazo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "¿Seguro? Borrar mazo" }));
    await waitFor(async () => expect(await db.decks.get(id)).toBeUndefined());
  });

  it("se lleva las palabras que le quedaban huérfanas", async () => {
    await seedDeck("A", ["run", "study", "child"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Borrar" }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));

    await waitFor(async () => expect(await db.decks.count()).toBe(0));
    // Sin `sources` no hay mazo al que pertenecer, y una palabra sin mazo no se
    // puede estudar: se queda inaccesible. La regla de huérfanos está en
    // `purge.test.ts`; aquí sólo se comprueba que la UI la dispara.
    expect(await db.nodes.count()).toBe(0);
    expect(await db.senses.count()).toBe(0);
  });

  it("NO toca las palabras marcadas como conocidas", async () => {
    await seedDeck("A", ["run", "study"]);
    await db.nodes.update(1, { known: 1 });
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Borrar" }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));

    await waitFor(async () => expect(await db.decks.count()).toBe(0));
    // La marca es un hecho sobre la persona, no sobre el import: sobrevive al mazo.
    const left = await db.nodes.toArray();
    expect(left).toHaveLength(1);
    expect(left[0]!.known).toBe(1);
  });

  it("limpia las filas de sources que lo vinculaban", async () => {
    await seedDeck("A", ["run"]);
    expect(await db.sources.count()).toBe(1);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Borrar" }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));

    // Sin esto, `sources` acumularía referencias a un mazo inexistente.
    await waitFor(async () => expect(await db.sources.count()).toBe(0));
  });

  it("el aviso dice cuántas palabras se fueron y cuántas se quedaron", async () => {
    await seedDeck("A", ["a1", "a2", "a3"]);
    await db.nodes.update(1, { known: 1 });
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Borrar" }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));

    // El aviso sale al terminar la transacción, no al pulsar.
    await waitFor(() =>
      expect(useApp.getState().toast).toBe(
        "Mazo «A» borrado. 2 palabras eliminadas, 1 conservada por estar marcada.",
      ),
    );
  });

  it("deja el resto de mazos intacto", async () => {
    const a = await seedDeck("A", ["run"]);
    await seedDeck("B", ["study"], NOW + 1);
    render(<Decks />);

    // Dos mazos, dos botones "Borrar": hay que elegir el panel correcto.
    // Con el orden `createdAt` desc, "B" (creado después) es el primero.
    const newest = (await screen.findAllByRole("button", { name: "Borrar" }))[0]!;
    fireEvent.click(newest);
    fireEvent.click(within(newest.closest(".panel")!).getByRole("button", { name: CONFIRM }));

    await waitFor(async () => expect(await db.decks.count()).toBe(1));
    expect((await db.decks.get(a))!.name).toBe("A");
  });

  it("no dice que las palabras siguen: ya no es verdad", async () => {
    await seedDeck("A", ["run"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Borrar" }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));

    await waitFor(() => expect(useApp.getState().toast).toContain("Mazo «A» borrado."));
    expect(useApp.getState().toast).not.toMatch(/siguen en la biblioteca/);
  });
});

describe("renombrar sin colisiones", () => {
  it("un nombre ya usado no se acepta y el campo sigue abierto", async () => {
    await seedDeck("A", ["run"]);
    await seedDeck("B", ["study"]);
    render(<Decks />);

    // Dos mazos, dos botones "Renombrar": hay que elegir el de A.
    fireEvent.click((await screen.findAllByRole("button", { name: "Renombrar" }))[0]!);
    const field = screen.getByLabelText("Nuevo nombre para A");
    fireEvent.change(field, { target: { value: "B" } });
    fireEvent.keyDown(field, { key: "Enter" });

    // `decks.name` está indexado pero no es único. Dos mazos con el mismo
    // nombre son indistinguibles en la lista y en cualquier filtro por texto.
    await waitFor(() => expect(useApp.getState().toast).toBe("Ya existe un mazo llamado «B»."));
    expect(screen.getByLabelText("Nuevo nombre para A")).toBeTruthy();
    expect(await db.decks.where("name").equals("A").count()).toBe(1);
    expect(await db.decks.where("name").equals("B").count()).toBe(1);
  });

  it("no colisiona consigo mismo", async () => {
    const id = await seedDeck("A", ["run"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Renombrar" }));
    const field = screen.getByLabelText("Nuevo nombre para A");
    fireEvent.change(field, { target: { value: "  A  " } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(screen.queryByLabelText("Nuevo nombre para A")).toBeNull());
    expect((await db.decks.get(id))!.name).toBe("A");
  });

  it("distingue mayúsculas", async () => {
    const id = await seedDeck("Inglés", ["run"]);
    render(<Decks />);

    fireEvent.click(await screen.findByRole("button", { name: "Renombrar" }));
    const field = screen.getByLabelText("Nuevo nombre para Inglés");
    fireEvent.change(field, { target: { value: "inglés" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(screen.queryByLabelText(/Nuevo nombre/)).toBeNull());
    expect((await db.decks.get(id))!.name).toBe("inglés");
  });
});

describe("orden y filtro", () => {
  it("el más reciente primero", async () => {
    await seedDeck("Viejo", ["a1"], NOW);
    await seedDeck("Medio", ["b1"], NOW + 1000);
    await seedDeck("Nuevo", ["c1"], NOW + 2000);
    render(<Decks />);

    await waitFor(() => expect(screen.getByText("Viejo")).toBeTruthy());
    const names = [...document.querySelectorAll(".panel")].map((p) => p.textContent!);
    expect(names[0]).toContain("Nuevo");
    expect(names[1]).toContain("Medio");
    expect(names[2]).toContain("Viejo");
  });

  it("con pocos mazos no hay campo de filtro: sería ruido", async () => {
    await seedDeck("A", ["a1"]);
    await seedDeck("B", ["b1"]);
    render(<Decks />);

    await waitFor(() => expect(screen.getByText("A")).toBeTruthy());
    expect(screen.queryByLabelText("Filtrar mazos por nombre")).toBeNull();
  });

  it("con muchos, filtra por nombre sin distinguir mayúsculas", async () => {
    for (const n of ["Verbos", "Sustantivos", "Adjetivos", "Adverbios"]) {
      await seedDeck(n, [n.slice(0, 3)]);
    }
    render(<Decks />);

    const field = await screen.findByLabelText("Filtrar mazos por nombre");
    fireEvent.change(field, { target: { value: "verbo" } });

    await waitFor(() => expect(screen.getByText("Verbos")).toBeTruthy());
    expect(screen.queryByText("Sustantivos")).toBeNull();
    expect(document.querySelectorAll(".panel")).toHaveLength(1);
  });

  it("un filtro sin coincidencias lo dice, no muestra un vacío mudo", async () => {
    for (const n of ["Verbos", "Sustantivos", "Adjetivos", "Adverbios"]) {
      await seedDeck(n, [n.slice(0, 3)]);
    }
    render(<Decks />);

    fireEvent.change(await screen.findByLabelText("Filtrar mazos por nombre"), {
      target: { value: "zzz" },
    });

    expect(await screen.findByText(/Ningún mazo se llama «zzz»/)).toBeTruthy();
  });

  it("espacios al borde del filtro no rompen la búsqueda", async () => {
    for (const n of ["Verbos", "Sustantivos", "Adjetivos", "Adverbios"]) {
      await seedDeck(n, [n.slice(0, 3)]);
    }
    render(<Decks />);

    fireEvent.change(await screen.findByLabelText("Filtrar mazos por nombre"), {
      target: { value: "  verbo  " },
    });

    await waitFor(() => expect(document.querySelectorAll(".panel")).toHaveLength(1));
  });
});

describe("tipo del mazo", () => {
  it("distingue importado de generado", async () => {
    await seedDeck("A", ["run"]);
    await db.decks.add({ name: "G", kind: "generated", sourceTextIds: [], createdAt: NOW + 1 });
    render(<Decks />);

    await waitFor(() => expect(screen.getByText("importado")).toBeTruthy());
    expect(screen.getByText("generado")).toBeTruthy();
  });
});
