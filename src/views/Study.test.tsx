// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db, type Node } from "../db";
import { newCard } from "../srs";
import { useApp } from "../store";
import Study from "./Study";
import type { StudyItem } from "../decks";

/**
 * Los comportamientos de `Study` que sólo se pueden comprobar renderizándolo.
 *
 * Los atajos de teclado ya están cubiertos en `shortcuts.test.ts` sin DOM; aquí
 * no se repiten. Lo que queda son las tres cosas que un test de función pura no
 * puede alcanzar: los subcomponentes privados `Revealed` y `Token` (con su diff
 * verde/rojo/gris), el gate de escritura — que sólo existe cuando hay frase, y
 * el reinicio de estado al pulsar «Reintentar», que es el único reset del repo
 * sin ningún test.
 *
 * Cero mocks: el store va real contra IndexedDB y `prefs.llm.model` está vacío,
 * así que `useSentenceTranslation` sale en su primera guarda y no hay red.
 */

const SENTENCE = "The noise startled the horses.";

function makeItem(over: Partial<StudyItem> = {}): StudyItem {
  const createdAt = 1_700_000_000_000;
  const node: Node = {
    id: 1,
    headword: "startle",
    lemma: "startle",
    kind: "word",
    known: 0,
    card: newCard(createdAt),
    due: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
  return { node, sentence: SENTENCE, ...over };
}

/** Estado de partida: una card en la cola, sin revelar y sin escribir. */
async function mount(items: StudyItem[]) {
  await db.nodes.bulkPut(items.map((i) => i.node));
  await db.senses.clear();
  useApp.setState({
    queue: items,
    pos: 0,
    revealed: false,
    typed: "",
    suggested: null,
    comparison: null,
    typingHint: false,
    toast: null,
    prefs: { ...useApp.getState().prefs, typingRequired: true },
  });
  return render(<Study />);
}

beforeEach(async () => {
  await db.open();
  await db.nodes.clear();
  await db.senses.clear();
  await db.decks.clear();
  await db.exposure.clear();
});

describe("sin cola no hay card", () => {
  it("no renderiza nada", async () => {
    await mount([]);
    expect(document.querySelector(".study")).toBeNull();
    expect(screen.queryByRole("button", { name: /Mostrar reverso/ })).toBeNull();
  });
});

describe("con frase: cloze en lugar de palabra suelta", () => {
  it("oculta la palabra y deja el resto de la frase", async () => {
    await mount([makeItem()]);
    // "startled" es la forma flexionada: `identify` la reduce a "startle", así
    // que el cloze cae sobre ella y el texto visible es lo que la rodea.
    expect(screen.getByLabelText("palabra oculta")).toBeTruthy();
    const sentence = document.querySelector(".sentence")!.textContent!;
    expect(sentence).toContain("The noise");
    expect(sentence).toContain("the horses");
    // La palabra no debe estar a la vista: ése es el objetivo del cloze.
    expect(sentence).not.toContain("startled");
  });

  it("sin frase, muestra el lemma y lo dice", async () => {
    await mount([makeItem({ sentence: undefined })]);
    expect(screen.getByText(/Sin frase disponible/)).toBeTruthy();
    expect(screen.getByText("startle")).toBeTruthy();
  });

  it("los dos botones de audio están siempre", async () => {
    await mount([makeItem()]);
    expect(screen.getByRole("button", { name: /Escuchar la frase/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Escuchar la palabra/ })).toBeTruthy();
  });
});

describe("escribir es obligatorio sólo si hay frase", () => {
  it("Enter sin escribir no revela, y avisa", async () => {
    await mount([makeItem()]);
    const input = screen.getByLabelText("Escribe la palabra en inglés");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("Escribe la palabra para revelar.")).toBeTruthy();
    expect(useApp.getState().revealed).toBe(false);
    // Sigue cerrada: la barra muestra "Mostrar reverso", no los 4 botones de grado.
    expect(screen.queryByRole("button", { name: /Fácil/ })).toBeNull();
  });

  it("con la palabra escrita, Enter sí revela", async () => {
    await mount([makeItem()]);
    const input = screen.getByLabelText("Escribe la palabra en inglés");

    fireEvent.change(input, { target: { value: "startle" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(useApp.getState().revealed).toBe(true));
    expect(screen.getByRole("button", { name: /Fácil/ })).toBeTruthy();
  });

  it("sin frase, Enter revela sin escribir nada", async () => {
    await mount([makeItem({ sentence: undefined })]);
    fireEvent.click(screen.getByRole("button", { name: /Mostrar reverso/ }));
    await waitFor(() => expect(useApp.getState().revealed).toBe(true));
  });
});

describe("el diff de lo que escribiste", () => {
  it("respuesta correcta: todo verde y sin botón de reintentar", async () => {
    await mount([makeItem()]);
    const input = screen.getByLabelText("Escribe la palabra en inglés");
    fireEvent.change(input, { target: { value: "startle" } });
    fireEvent.click(screen.getByRole("button", { name: /Mostrar reverso/ }));

    await waitFor(() => expect(useApp.getState().revealed).toBe(true));
    expect(document.querySelectorAll(".diff .g").length).toBe(1);
    expect(document.querySelectorAll(".diff .b").length).toBe(0);
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
  });

  it("respuesta incorrecta: rojo, el hueco marcado y botón de reintentar", async () => {
    await mount([makeItem()]);
    const input = screen.getByLabelText("Escribe la palabra en inglés");
    // "startl" y no "startla": el diff es por graphemes, así que una letra de
    // menos produce `insert` — que es el caso que pinta el hueco `_`. Con una
    // letra cambiada sale `replace` y el hueco no aparece.
    fireEvent.change(input, { target: { value: "startl" } });
    fireEvent.click(screen.getByRole("button", { name: /Mostrar reverso/ }));

    await waitFor(() => expect(useApp.getState().revealed).toBe(true));
    // Lo escrito se ve en verde; lo que falta, como hueco `_` (no como guion).
    expect(document.querySelectorAll(".diff .g").length).toBeGreaterThan(0);
    expect(document.querySelector(".diff .m")?.textContent).toBe("_");
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
  });

  it("letra cambiada en vez de omitida: rojo, sin hueco", async () => {
    await mount([makeItem()]);
    const input = screen.getByLabelText("Escribe la palabra en inglés");
    fireEvent.change(input, { target: { value: "startla" } });
    fireEvent.click(screen.getByRole("button", { name: /Mostrar reverso/ }));

    await waitFor(() => expect(useApp.getState().revealed).toBe(true));
    expect(document.querySelectorAll(".diff .b").length).toBeGreaterThan(0);
    expect(document.querySelector(".diff .m")?.textContent).not.toBe("_");
  });

  it("sin escribir no hay diff: sólo la respuesta", async () => {
    await mount([makeItem({ sentence: undefined })]);
    fireEvent.click(screen.getByRole("button", { name: /Mostrar reverso/ }));

    await waitFor(() => expect(useApp.getState().revealed).toBe(true));
    // Sin escribir no hay `comparison`, así que no hay diff ni el `aria-label`
    // de "respuesta correcta": ése sólo existe en la rama con diff.
    expect(document.querySelector(".diff")).toBeNull();
    expect(screen.queryByLabelText("respuesta correcta")).toBeNull();
    expect(document.querySelector(".answer")?.textContent).toBe("startle");
  });
});

describe("Reintentar devuelve la card a su estado inicial", () => {
  it("limpia escrito, comparación y sugerencia", async () => {
    await mount([makeItem()]);
    const input = screen.getByLabelText("Escribe la palabra en inglés");
    fireEvent.change(input, { target: { value: "startla" } });
    fireEvent.click(screen.getByRole("button", { name: /Mostrar reverso/ }));
    await waitFor(() => expect(useApp.getState().revealed).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    // Este es el único reset de estado del proyecto y era el que no tenía test.
    const s = useApp.getState();
    expect(s.revealed).toBe(false);
    expect(s.typed).toBe("");
    expect(s.comparison).toBeNull();
    expect(s.suggested).toBeNull();
    expect(s.toast).toBe("Escribe de nuevo.");
    // Y la UI vuelve a pedir la escritura.
    expect(screen.getByLabelText("Escribe la palabra en inglés")).toBeTruthy();
  });
});

describe("la barra de grados cambia al revelar", () => {
  it("cerrada: un botón para voltear", async () => {
    await mount([makeItem()]);
    expect(screen.getByRole("button", { name: /Mostrar reverso/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fácil/ })).toBeNull();
  });

  it("revelada: cuatro botones con su tecla y sólo uno sugerido", async () => {
    await mount([makeItem()]);
    const input = screen.getByLabelText("Escribe la palabra en inglés");
    // Exacto a propósito: la sugerencia por coincidencia debe ser "Fácil".
    fireEvent.change(input, { target: { value: "startle" } });
    fireEvent.click(screen.getByRole("button", { name: /Mostrar reverso/ }));
    await waitFor(() => expect(useApp.getState().revealed).toBe(true));

    const grades = document.querySelectorAll(".grades button");
    expect(grades.length).toBe(4);
    // Los <kbd> deben coincidir con las teclas del atajo: 1..4.
    expect([...grades].map((g) => g.querySelector("kbd")?.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    const suggested = [...grades].filter((g) => g.getAttribute("data-suggested") === "true");
    expect(suggested.length).toBe(1);
    expect(suggested[0]!.textContent).toContain("Fácil");
  });
});
