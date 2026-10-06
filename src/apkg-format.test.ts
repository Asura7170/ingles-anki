import { describe, expect, it } from "vite-plus/test";
import { levelOf, rootOf, stripHtml } from "./apkg-format";

/**
 * La jerarquía de sub-decks ES el nivel. Es lo que permite "terminé el Book 1"
 * ser un clic y no 1.000 marcas manuales.
 */
describe("levelOf", () => {
  it("un subdeck extrae el nivel", () => {
    expect(levelOf("4000 Essential English Words::Book 1")).toBe("Book 1");
  });

  it("anida varios niveles", () => {
    expect(levelOf("Deck::Unit 3::Part B")).toBe("Unit 3 › Part B");
  });

  it('el deck raíz es "raíz"', () => {
    expect(levelOf("Deck")).toBe("raíz");
  });

  it("sin nombre → sin nivel", () => {
    expect(levelOf(undefined)).toBe("sin nivel");
    expect(levelOf("")).toBe("sin nivel");
  });

  it("tolera espacios sobrantes", () => {
    expect(levelOf("Deck::  Book 2  ")).toBe("Book 2");
  });
});

describe("rootOf", () => {
  it("extrae el mazo raíz de una jerarquía", () => {
    expect(rootOf("4000 Essential English Words::Book 1")).toBe("4000 Essential English Words");
  });

  it("un mazo sin subdeck se devuelve tal cual", () => {
    expect(rootOf("Deck")).toBe("Deck");
  });

  it("con doble separador al inicio no queda vacío", () => {
    expect(rootOf("::Book 1")).toBe("Book 1");
  });
});

describe("stripHtml", () => {
  it("quita etiquetas y colapsa espacios", () => {
    expect(stripHtml("<b>run</b>")).toBe("run");
    expect(stripHtml("  a   b  ")).toBe("a b");
  });

  it("convierte <br> y </div> en espacio, no en nada", () => {
    // Unir sin espacio produciría "runthe".
    expect(stripHtml("run<br>the")).toBe("run the");
    expect(stripHtml("<div>a</div><div>b</div>")).toBe("a b");
  });

  it("decodifica entidades comunes", () => {
    expect(stripHtml("a &amp; b")).toBe("a & b");
    expect(stripHtml("&lt;tag&gt;")).toBe("<tag>");
    expect(stripHtml("a&nbsp;b")).toBe("a b");
    expect(stripHtml("&#65;")).toBe("A");
  });

  it("elimina los tags [sound:] de Anki", () => {
    // El audio del .apkg no se usa (el TTS es del navegador), pero el tag
    //留在 el texto sería ruido visible en la card.
    expect(stripHtml("run[sound:run.mp3]")).toBe("run");
  });
});
