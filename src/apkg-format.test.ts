import { describe, expect, it } from "vite-plus/test";
import { findImages, levelOf, mimeOf, rootOf, stripHtml } from "./apkg-format";

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

/**
 * `findImages` es función aparte y NO un cambio en `stripHtml`: los 4 `it` de
 * arriba siguen probando que el texto sale limpio, y estos prueban que el
 * nombre sale por otro canal. Si algún día se fusionan, estos son los que
 * delatan la regresión.
 */
describe("findImages", () => {
  it("extrae el src de un <img> con comillas dobles", () => {
    expect(findImages('<img src="cat.jpg">')).toEqual(["cat.jpg"]);
  });

  it("acepta comillas simples y espacio alrededor del =", () => {
    // El round-trip de Anki usa ambas; un editor de terceros, espacios.
    expect(findImages("<img src='dog.png'>")).toEqual(["dog.png"]);
    expect(findImages('<img  src = "bird.webp" width="300">')).toEqual(["bird.webp"]);
  });

  it("ignora lo que no es <img> y lo que no tiene src", () => {
    expect(findImages("<b>run</b>")).toEqual([]);
    expect(findImages("<img>")).toEqual([]);
    expect(findImages("<audio><source src='x.mp3'></audio>")).toEqual([]);
    expect(findImages("run[sound:run.mp3]")).toEqual([]);
  });

  it("descarta URLs remotas: Anki nunca las descarga", () => {
    // Guardarlas sería pedirle la imagen a un tercero en cada repaso.
    expect(findImages('<img src="https://ejemplo.com/cat.jpg">')).toEqual([]);
    expect(findImages('<img src="http://ejemplo.com/c.jpg">')).toEqual([]);
    expect(findImages('<img src="ftp://ejemplo.com/c.jpg">')).toEqual([]);
  });

  it("desescapa entidades pero no toca el resto del nombre", () => {
    // Anki guarda el nombre crudo: espacios, % y & van tal cual. Sólo las
    // entidades se deshacen, y `&amp;` la última para no decodificar dos veces.
    expect(findImages('<img src="dog and bone.png">')).toEqual(["dog and bone.png"]);
    expect(findImages('<img src="100%.jpg">')).toEqual(["100%.jpg"]);
    expect(findImages('<img src="a&amp;b.jpg">')).toEqual(["a&b.jpg"]);
    expect(findImages('<img src="a&amp;lt;.jpg">')).toEqual(["a&lt;.jpg"]);
    expect(findImages('<img src="it&apos;s.jpg">')).toEqual(["it's.jpg"]);
    expect(findImages('<img src="say&quot;hi.jpg">')).toEqual(['say"hi.jpg']);
  });

  it("dedupica preservando el orden de aparición", () => {
    expect(findImages('<img src="a.jpg"> x <img src="a.jpg"> y <img src="b.jpg">')).toEqual([
      "a.jpg",
      "b.jpg",
    ]);
  });

  it("vacío y src vacío dan vacío", () => {
    expect(findImages("")).toEqual([]);
    expect(findImages('<img src="">')).toEqual([]);
  });
});

describe("mimeOf", () => {
  it("reconoce las extensiones que <img> pinta", () => {
    expect(mimeOf("cat.jpg")).toBe("image/jpeg");
    expect(mimeOf("cat.JPEG")).toBe("image/jpeg");
    expect(mimeOf("dog.png")).toBe("image/png");
    expect(mimeOf("anim.gif")).toBe("image/gif");
    expect(mimeOf("foto.webp")).toBe("image/webp");
    expect(mimeOf("foto.avif")).toBe("image/avif");
    expect(mimeOf("dibujo.svg")).toBe("image/svg+xml");
  });

  it('"" cuando no se reconoce: el llamador la salta, no la rompe', () => {
    expect(mimeOf("sonido.mp3")).toBe("");
    expect(mimeOf("sin-extension")).toBe("");
    expect(mimeOf("cat.jpg.txt")).toBe("");
  });
});
