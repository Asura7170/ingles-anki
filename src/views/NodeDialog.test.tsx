// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db, type Node } from "../db";
import { newCard } from "../srs";
import { NodeDialog } from "./Words";

/**
 * La pieza de UI con más comportamiento: decide entre dos intenciones opuestas
 * para una palabra marcada como conocida. Equivocar ese «reset» frente a «sólo
 * que aparezca» borra el historial de repaso del usuario sin avisar, así que el
 * test comprueba el efecto real en la base, no sólo que el botón existe.
 *
 * Este fichero es el que justifica `happy-dom`: `dialog.showModal()` y
 * `HTMLDialogElement.close()` existen en happy-dom y **no** en jsdom. Con jsdom
 * el diálogo jamás abriría y habría que polyfillarlo.
 *
 * El store va de verdad contra IndexedDB en vez de mockeado: el punto es
 * precisamente que el clic llegue a `db.nodes`. Mockear `unmark` haría pasar el
 * test aunque el store estuviera roto.
 */

const UNMARK_RESET = "No la sé — reiniciar historial";
const UNMARK_DUE = "La sé, sólo quiero verla antes";

function makeNode(over: Partial<Node> = {}): Node {
  const createdAt = 1_700_000_000_000;
  return {
    id: 1,
    lemma: "startle",
    headword: "startle",
    kind: "word",
    known: 0,
    createdAt,
    updatedAt: createdAt,
    due: createdAt,
    // Un historial real: sin él no se puede comprobar que "reset" lo destruye.
    card: { ...newCard(createdAt), reps: 7, lapses: 2, stability: 12.5 },
    ...over,
  };
}

/** Lee el nodo de la base, que es donde acaba de escribir el store. */
const reload = (id = 1) => db.nodes.get(id);

beforeEach(async () => {
  await db.open();
  await db.nodes.clear();
  await db.senses.clear();
  await db.exposure.clear();
  await db.decks.clear();
  await db.sourceTexts.clear();
});

afterEach(cleanup);

describe("el diálogo se abre", () => {
  it("se monta como modal, gracias a showModal()", () => {
    const node = makeNode();
    render(<NodeDialog node={node} onClose={() => {}} />);
    const dialog = document.querySelector("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.open).toBe(true);
  });

  it("muestra la palabra, el tipo y el historial", () => {
    render(<NodeDialog node={makeNode()} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "startle" })).toBeTruthy();
    expect(screen.getByText(/7 repasos/)).toBeTruthy();
    expect(screen.getByText(/estabilidad 12\.5 d/)).toBeTruthy();
  });

  it("sin historial lo dice en vez de mostrar ceros", () => {
    render(<NodeDialog node={makeNode({ card: undefined })} onClose={() => {}} />);
    expect(screen.getByText("Sin historial de repaso.")).toBeTruthy();
  });
});

describe("palabra NO conocida", () => {
  it("no ofrece las dos opciones de desmarcar", () => {
    render(<NodeDialog node={makeNode({ known: 0 })} onClose={() => {}} />);
    expect(screen.queryByText(UNMARK_RESET)).toBeNull();
    expect(screen.queryByText(UNMARK_DUE)).toBeNull();
    expect(screen.getByText(/desaparece de la generación/)).toBeTruthy();
  });
});

describe("palabra conocida: las dos intenciones son opuestas", () => {
  it("«no la sé» reinicia el historial y la saca de conocida", async () => {
    const node = makeNode({ known: 1 });
    await db.nodes.put(node);
    render(<NodeDialog node={node} onClose={() => {}} />);

    fireEvent.click(screen.getByText(UNMARK_RESET));

    // `unmark` es async y el botón lo dispara con `void`: hay que esperar a que
    // la escritura en IndexedDB termine antes de releer.
    await waitFor(async () => expect((await reload())!.known).toBe(0));
    const after = await reload();
    // Esto es lo que distingue la opción: el historial se destruye.
    expect(after!.card!.reps).toBe(0);
    expect(after!.card!.stability).toBe(0);
  });

  it("«sólo quiero verla» conserva el historial y la vence", async () => {
    const node = makeNode({ known: 1 });
    await db.nodes.put(node);
    render(<NodeDialog node={node} onClose={() => {}} />);

    fireEvent.click(screen.getByText(UNMARK_DUE));

    await waitFor(async () => expect((await reload())!.known).toBe(0));
    const after = await reload();
    // El contraste con el test anterior: aquí el SRS sobrevive.
    expect(after!.card!.reps).toBe(7);
    expect(after!.card!.stability).toBe(12.5);
    expect(after!.due).toBeLessThanOrEqual(Date.now());
  });
});

describe("cerrar el diálogo", () => {
  it("el botón cerrar llama a onClose y cierra el <dialog>", () => {
    let closed = 0;
    render(<NodeDialog node={makeNode()} onClose={() => (closed += 1)} />);
    const dialog = document.querySelector("dialog") as HTMLDialogElement;

    fireEvent.click(screen.getByText("cerrar"));

    expect(closed).toBe(1);
    expect(dialog.open).toBe(false);
  });

  it("Escape (onCancel) también cierra", () => {
    let closed = 0;
    render(<NodeDialog node={makeNode()} onClose={() => (closed += 1)} />);
    const dialog = document.querySelector("dialog") as HTMLDialogElement;

    // `cancel` es el evento que dispara Escape en un <dialog> nativo.
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    expect(closed).toBe(1);
    expect(dialog.open).toBe(false);
  });

  it("desmarcar también cierra", async () => {
    const node = makeNode({ known: 1 });
    await db.nodes.put(node);
    let closed = 0;
    render(<NodeDialog node={node} onClose={() => (closed += 1)} />);

    fireEvent.click(screen.getByText(UNMARK_RESET));

    expect(closed).toBe(1);
  });
});
