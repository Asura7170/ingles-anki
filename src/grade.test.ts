import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THRESHOLD, gradeTyping, hasTypingContext } from "./grade";
import { expectedWord } from "./identity";

/**
 * Anki NO califica la respuesta escrita: el manual lo dice ("does not change how
 * the cards are answered") y el código no tiene ningún contador. Esto es diseño
 * propio, y es la pieza que convierte el typing en aprendizaje en vez de en
 * decoración.
 */
describe("gradeTyping", () => {
  it("exacto → Fácil", () => {
    expect(gradeTyping("run", "run").suggested).toBe(4);
  });

  it("solo vale la forma exacta del contexto, no el infinitivo", () => {
    // "He cries…": la respuesta es "cries". Escribir "cry" da "cr" en verde
    // y la "y" en rojo: cerca, pero no es lo que la frase pide.
    expect(gradeTyping("cries", "cries").suggested).toBe(4);
    const r = gradeTyping("cries", "cry");
    expect(r.comparison.exact).toBe(false);
    expect(r.suggested).toBe(1);
    expect(r.comparison.typedLine.map((t) => `${t.kind}:${t.text}`).join("|")).toBe(
      "good:cr|bad:y",
    );
  });

  it("la forma exacta admite mayúsculas y espacios", () => {
    expect(gradeTyping("cries", "Cries").suggested).toBe(4);
    expect(gradeTyping("cries", "  cries  ").suggested).toBe(4);
  });

  it("al final de frase, lo correcto da Fácil (sin el punto)", () => {
    // "I love apples.": lo esperado es "apples" y escribirlo da 4. Con el
    // punto adherido daba 6/7 → "Difícil" a una respuesta correcta.
    expect(
      gradeTyping(expectedWord({ lemma: "apple" }, "I love apples."), "apples").suggested,
    ).toBe(4);
  });

  it("otra palabra sigue saliendo mal", () => {
    expect(gradeTyping("cry", "dog").suggested).toBe(1);
    expect(gradeTyping("cry", "cry cry").suggested).toBe(1);
  });

  it("un error en palabra larga → Difícil, no Otra vez", () => {
    // `sturtle` vs `startle`: ok=6, bad=1, missing=1 → 6/7 = 0.857 ≥ 0.8.
    // Un error de dedo no debe mandarte al intervalo de 10 minutos.
    const r = gradeTyping("startle", "sturtle");
    expect(r.comparison.ok).toBe(6);
    expect(r.comparison.bad).toBe(1);
    expect(r.suggested).toBe(2);
  });

  it("una palabra corta con un error NO alcanza el umbral", () => {
    // run/ren: 2/3 = 0.667 < 0.8 → Otra vez. En una palabra de 3 letras un
    // error es un tercio del término, no un dedo mal puesto.
    expect(gradeTyping("run", "ren").suggested).toBe(1);
  });

  it("sin saber la palabra → Otra vez", () => {
    expect(gradeTyping("startle", "zzzzzz").suggested).toBe(1);
  });

  it("no escribió → null, la calificación es manual", () => {
    expect(gradeTyping("startle", "   ").suggested).toBeNull();
    expect(gradeTyping("startle", "").suggested).toBeNull();
  });

  it("el umbral es configurable", () => {
    // Con umbral 1.0, 5/6 deja de ser Difícil.
    expect(gradeTyping("startle", "sturtle", 0.8).suggested).toBe(2);
    expect(gradeTyping("startle", "sturtle", 1).suggested).toBe(1);
  });

  it("palabras cortas: el mismo ratio pesa distinto", () => {
    // Es el motivo de que el umbral viva en Ajustes y no sea fijo en el código.
    expect(gradeTyping("run", "rzn").suggested).toBe(1);
    expect(gradeTyping("startle", "sturtle").suggested).toBe(2);
  });

  it("expone el diff para poder pintar la card", () => {
    const { comparison } = gradeTyping("stroll", "strall");
    expect(comparison.ok).toBe(5);
    expect(comparison.bad).toBe(1);
    expect(comparison.typedLine.length).toBeGreaterThan(0);
  });

  it("el default es 0.8", () => {
    expect(DEFAULT_THRESHOLD).toBe(0.8);
  });
});

describe("hasTypingContext", () => {
  it("una frase de 3+ palabras obliga a escribir", () => {
    expect(hasTypingContext("She runs every morning")).toBe(true);
  });

  it("sin frase el typing no se exige", () => {
    // Sin contexto no hay recuperación posible: exigir escritura es mantenimiento.
    expect(hasTypingContext(undefined)).toBe(false);
    expect(hasTypingContext("")).toBe(false);
    expect(hasTypingContext("run")).toBe(false);
    expect(hasTypingContext("She runs")).toBe(false);
  });
});
