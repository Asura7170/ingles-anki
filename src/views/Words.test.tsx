// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "../db";
import { ingest, type IngestItem } from "../ingest";
import { useApp } from "../store";
import Words from "./Words";

/**
 * `Words` tenía CC 16 y 0 % de cobertura, casi todo `??` y `?.` en JSX: es el
 * mismo caso que `DeckCard`, y el mismo trato — se ejecuta, no se refactoriza.
 *
 * Lo que importa aquí no es el refrito de la lista (eso ya lo hacía el
 * virtualizador) sino el borrado, que no existía: palabra individual, selección
 * múltiple y "seleccionar todas". Y una asimetría deliberada: borrar un mazo
 * respeta la marca «conocida», borrar una palabra no. Es una acción explícita
 * sobre filas concretas, así que borra lo que señalaste.
 *
 * `ingest()` llama a `loadFrequency()`, que hace `fetch("/frequency.json")`. En
 * happy-dom la URL relativa se resuelve contra el base del documento y node
 * intenta conectar de verdad; el `catch` de `loadFrequency` lo silencia pero
 * vitest lo reporta igual. Mismo apaño que en `Decks.test.tsx`.
 */

const NOW = 1_700_000_000_000;

const item = (lemma: string): IngestItem => ({
  headword: lemma,
  lemma,
  kind: "word",
  translations: [`tr-${lemma}`],
});

async function seed(words: string[]): Promise<void> {
  for (const w of words) await ingest([item(w)], { kind: "apkg", priority: 30, noteId: 1 });
}

const lemmaOf = (lemma: string) => `Seleccionar ${lemma}`;
const markOf = (lemma: string) => `Marcar ${lemma} como conocida`;
const ALL = "Seleccionar todas las palabras visibles";

const count = () => document.querySelectorAll(".trow:not(.thead)").length;

/**
 * Espera a que haya filas antes de interactuar.
 *
 * La casilla «seleccionar todas» existe aunque la lista esté vacía, así que
 * `findByRole` la encuentra al instante y un clic sobre ella nace con
 * `visibleIds` vacío: seleccionar cero. Sin esta espera el test pasa por la UI
 * y no prueba nada.
 */
async function renderList(): Promise<void> {
  render(<Words />);
  await waitFor(() => expect(count()).toBeGreaterThan(0));
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await db.delete();
  await db.open();
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
  useApp.setState({ busy: null, toast: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("seleccionar una", () => {
  it("marca la casilla y muestra el botón de borrar", async () => {
    await seed(["run"]);
    await renderList();
    const box = screen.getByRole("checkbox", { name: lemmaOf("run") });

    expect(screen.queryByRole("button", { name: /Borrar seleccionadas/ })).toBeNull();
    fireEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByRole("button", { name: /Borrar seleccionadas/ })).toBeTruthy();
  });

  it("volver a pulsar la deselecciona y esconde el botón", async () => {
    await seed(["run"]);
    await renderList();
    const box = screen.getByRole("checkbox", { name: lemmaOf("run") });

    fireEvent.click(box);
    fireEvent.click(box);
    expect(screen.queryByRole("button", { name: /Borrar seleccionadas/ })).toBeNull();
  });

  it("la casilla de «conocida» es independiente de la de seleccionar", async () => {
    await seed(["run"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: lemmaOf("run") }));
    // Marcar como conocida no selecciona, y seleccionar no marca como conocida:
    // son dos intenciones y equivocarse borra el progreso de repaso.
    const known = screen.getByRole("checkbox", { name: markOf("run") }) as HTMLInputElement;
    expect(known.checked).toBe(false);
    expect((await db.nodes.where("lemma").equals("run").first())!.known).toBe(0);
  });
});

describe("seleccionar todas", () => {
  it("marca todas las visibles y el botón dice cuántas", async () => {
    await seed(["run", "study", "child"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: ALL }));
    expect(await screen.findByText("3 seleccionadas")).toBeTruthy();
  });

  it("sólo marca lo que se ve: filtrar acota la selección", async () => {
    await seed(["run", "study", "child"]);
    await renderList();

    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "ru" } });
    await waitFor(() => expect(count()).toBe(1));
    fireEvent.click(screen.getByRole("checkbox", { name: ALL }));

    expect(await screen.findByText("1 seleccionadas")).toBeTruthy();
    // La palabra filtrada fuera no se puede borrar sin verla antes.
    expect(await db.nodes.count()).toBe(3);
  });

  it("«sólo lo que no sé» también acota", async () => {
    await seed(["run", "study"]);
    await db.nodes.update(1, { known: 1 });
    await renderList();

    fireEvent.click(screen.getByLabelText("sólo lo que no sé"));
    await waitFor(() => expect(count()).toBe(1));
    fireEvent.click(screen.getByRole("checkbox", { name: ALL }));
    expect(await screen.findByText("1 seleccionadas")).toBeTruthy();
  });

  it("desmarca todo con un segundo clic", async () => {
    await seed(["run", "study"]);
    await renderList();

    const all = screen.getByRole("checkbox", { name: ALL });
    fireEvent.click(all);
    await screen.findByText("2 seleccionadas");
    fireEvent.click(all);
    expect(screen.queryByRole("button", { name: /Borrar seleccionadas/ })).toBeNull();
  });

  it("selección parcial deja la casilla en indeterminate, no vacía", async () => {
    // Sin esto, con 1 de 3 seleccionadas la casilla se ve vacía y un clic
    // borraría las 3. Es pérdida de datos, no un detalle de estilo.
    await seed(["run", "study", "child"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: lemmaOf("run") }));
    const all = screen.getByRole("checkbox", { name: ALL }) as HTMLInputElement;
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);

    // Y un clic pasa a "todas", no a "ninguna".
    fireEvent.click(all);
    await waitFor(() => expect(all.indeterminate).toBe(false));
    expect((all as HTMLInputElement).checked).toBe(true);
  });
});

describe("borrar las seleccionadas", () => {
  it("pide confirmación y no borra al primer clic", async () => {
    await seed(["run", "study"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: lemmaOf("run") }));
    fireEvent.click(await screen.findByRole("button", { name: /Borrar seleccionadas/ }));

    // El botón destructivo es distinto del que abrió el diálogo.
    expect(screen.getByRole("button", { name: "¿Seguro? Borrar 1" })).toBeTruthy();
    expect(await db.nodes.count()).toBe(2);
  });

  it("confirmado, borra exactamente lo seleccionado", async () => {
    await seed(["run", "study", "child"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: lemmaOf("run") }));
    fireEvent.click(await screen.findByRole("checkbox", { name: lemmaOf("child") }));
    fireEvent.click(screen.getByRole("button", { name: /Borrar seleccionadas/ }));
    fireEvent.click(screen.getByRole("button", { name: "¿Seguro? Borrar 2" }));

    await waitFor(async () => expect(await db.nodes.count()).toBe(1));
    expect((await db.nodes.toArray())[0]!.lemma).toBe("study");
  });

  it("Cancelar no borra nada", async () => {
    await seed(["run"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: lemmaOf("run") }));
    fireEvent.click(await screen.findByRole("button", { name: /Borrar seleccionadas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(await db.nodes.count()).toBe(1);
    expect(screen.queryByRole("button", { name: /^¿Seguro\?/ })).toBeNull();
  });

  it("ignora la marca «conocida»: borra lo que señalaste", async () => {
    await seed(["run"]);
    await db.nodes.update(1, { known: 1 });
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: lemmaOf("run") }));
    fireEvent.click(await screen.findByRole("button", { name: /Borrar seleccionadas/ }));
    fireEvent.click(screen.getByRole("button", { name: "¿Seguro? Borrar 1" }));

    // Deliberadamente distinto de borrar un mazo, que sí respeta la marca.
    await waitFor(async () => expect(await db.nodes.count()).toBe(0));
  });

  it("limpia la selección tras borrar", async () => {
    await seed(["run", "study"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: lemmaOf("run") }));
    fireEvent.click(await screen.findByRole("button", { name: /Borrar seleccionadas/ }));
    fireEvent.click(screen.getByRole("button", { name: "¿Seguro? Borrar 1" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /Borrar/ })).toBeNull());
    await waitFor(() => expect(count()).toBe(1));
  });

  it("«seleccionar todas» y borrar vacía la biblioteca", async () => {
    await seed(["run", "study", "child"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: ALL }));
    fireEvent.click(await screen.findByRole("button", { name: /Borrar seleccionadas/ }));
    fireEvent.click(screen.getByRole("button", { name: "¿Seguro? Borrar 3" }));

    await waitFor(async () => expect(await db.nodes.count()).toBe(0));
    expect(await db.senses.count()).toBe(0);
  });
});

describe("borrar una palabra desde el detalle", () => {
  it("el diálogo ofrece borrarla, con su confirmación", async () => {
    await seed(["run"]);
    await renderList();

    fireEvent.click(screen.getByRole("button", { name: "detalle" }));
    fireEvent.click(await screen.findByRole("button", { name: "Borrar palabra" }));
    fireEvent.click(await screen.findByRole("button", { name: "¿Seguro? Borrar «run»" }));

    await waitFor(async () => expect(await db.nodes.count()).toBe(1));
    // El diálogo se cierra solo: si no, apuntaría a una fila que ya no existe.
    await waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  });

  it("Cancelar deja la palabra", async () => {
    await seed(["run"]);
    await renderList();

    fireEvent.click(screen.getByRole("button", { name: "detalle" }));
    fireEvent.click(await screen.findByRole("button", { name: "Borrar palabra" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(await db.nodes.count()).toBe(1);
    expect(screen.queryByRole("button", { name: /^¿Seguro\?/ })).toBeNull();
  });

  it("si la palabra estaba seleccionada, la deselecciona", async () => {
    await seed(["run"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: lemmaOf("run") }));
    fireEvent.click(screen.getByRole("button", { name: "detalle" }));
    fireEvent.click(await screen.findByRole("button", { name: "Borrar palabra" }));
    fireEvent.click(screen.getByRole("button", { name: "¿Seguro? Borrar «run»" }));

    // Dejarla seleccionada haría que un "borrar seleccionadas" posterior contara
    // una palabra que ya no existe.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Borrar/ })).toBeNull());
  });

  it("el aviso dice cuántas se fueron", async () => {
    await seed(["run"]);
    await renderList();

    fireEvent.click(screen.getByRole("checkbox", { name: lemmaOf("run") }));
    fireEvent.click(await screen.findByRole("button", { name: /Borrar seleccionadas/ }));
    fireEvent.click(screen.getByRole("button", { name: "¿Seguro? Borrar 1" }));

    await waitFor(() => expect(useApp.getState().toast).toBe("1 palabra eliminada."));
  });
});

describe("la lista sigue funcionando", () => {
  it("la búsqueda no filtra por selección", async () => {
    await seed(["run", "study"]);
    await renderList();

    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "zzz" } });
    await waitFor(() => expect(count()).toBe(0));
    expect(screen.getByRole("checkbox", { name: ALL })).toBeTruthy();
  });

  it("una palabra nueva aparece sin recargar", async () => {
    await seed(["run"]);
    await renderList();

    await ingest([item("child")], { kind: "apkg", priority: 30, noteId: 2 });
    await waitFor(() => expect(count()).toBe(2));
  });
});
