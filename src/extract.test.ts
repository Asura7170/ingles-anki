import { describe, expect, it } from "vite-plus/test";
import { extractCandidates, blankSentence } from "./identity";

/**
 * El pipeline que convierte una transcripción en candidatos de mazo. Es donde
 * falla el sistema si la selección de frase es mala: una frase con 6 palabras
 * raras no es un ancla mnemotécnica, es otro problema.
 */
const TRANSCRIPT = `The noise startled the horses. They went running across the field.
The children were running too, and their studies were interrupted.
I gave up after running three miles. Running is easier than running uphill.`;

describe("extractCandidates", () => {
  const cands = extractCandidates(TRANSCRIPT);

  it("colapsa flexiones al mismo lemma y cuenta repeticiones", () => {
    const run = cands.find((c) => c.lemma === "run");
    expect(run).toBeDefined();
    // running x4 + running = 5
    expect(run!.occurrences).toBe(5);
  });

  it("reduce las flexiones irregulares", () => {
    expect(cands.find((c) => c.lemma === "go")?.occurrences).toBe(1);
    expect(cands.find((c) => c.lemma === "child")?.occurrences).toBe(1);
    expect(cands.find((c) => c.lemma === "study")?.occurrences).toBe(1);
  });

  it("conserva la forma observada como headword", () => {
    expect(cands.find((c) => c.lemma === "go")?.headword).toBe("went");
    expect(cands.find((c) => c.lemma === "child")?.headword).toBe("children");
  });

  it("descarta stopwords y muletillas", () => {
    for (const junk of ["the", "and", "after", "too", "were"]) {
      expect(cands.find((c) => c.lemma === junk)).toBeUndefined();
    }
  });

  it("el lemma es único por candidato", () => {
    expect(new Set(cands.map((c) => c.lemma)).size).toBe(cands.length);
  });

  it("el lemma es también único como clave de lookup", () => {
    // El índice `&lemma` de Dexie exige unicidad real: si un lemma se repitiese,
    // el segundo add() lanzaría ConstraintError y la importación se caería.
    const cands = extractCandidates("running runs ran run running runs ran");
    expect(new Set(cands.map((c) => c.lemma)).size).toBe(cands.length);
    expect(cands).toHaveLength(1);
  });

  it("la frase más corta sustituye a la primera cuando el lemma se repite", () => {
    // `running` aparece primero en la frase larga; la card debe usar la corta.
    const cands = extractCandidates(
      "The extraordinarily complicated administrative framework demands running scrutiny. A cat ran.",
    );
    const run = cands.find((c) => c.lemma === "run");
    expect(run!.occurrences).toBe(2);
    expect(run!.bestSentence).toBe("A cat ran.");
  });

  it("cada candidato conserva una frase con ≥3 palabras", () => {
    for (const c of cands) {
      expect(c.bestSentence!.split(/\s+/).length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("extractCandidates — selección de la frase más corta", () => {
  it("contexto mínimo gana cuando hay dos candidatas", () => {
    const text =
      "Big and complicated sentences with many extra words confuse learners. The cat slept.";
    const cands = extractCandidates(text);
    const cat = cands.find((c) => c.lemma === "cat");
    expect(cat!.bestSentence).toBe("The cat slept.");
  });

  it("descarta la frase demasiado corta pero conserva la larga", () => {
    // "Elephants." y "Fine." no llegan a 3 palabras: no sirven de contexto. La
    // siguiente sí, y es la que gana.
    const cands = extractCandidates("Elephants. Big grey elephants roam. Fine.");
    const elephant = cands.find((c) => c.lemma === "elephant");
    expect(elephant!.bestSentence).toBe("Big grey elephants roam.");
  });

  it("punto y coma y saltos de línea separan frases", () => {
    const cands = extractCandidates("The horse ran; it was fast. Birds flew above the lake.");
    expect(cands.find((c) => c.lemma === "horse")?.bestSentence).toBe(
      "The horse ran; it was fast.",
    );
    expect(cands.find((c) => c.lemma === "lake")?.bestSentence).toBe("Birds flew above the lake.");
  });
});

describe("extractCandidates — texto vacío", () => {
  it("no lanza y devuelve vacío", () => {
    expect(extractCandidates("")).toEqual([]);
    expect(extractCandidates("   \n\n  ")).toEqual([]);
  });

  it("sólo stopwords no produce candidatos", () => {
    expect(extractCandidates("the and but or of to in on at it is")).toEqual([]);
  });
});

describe("blankSentence", () => {
  it("encuentra la palabra aunque esté flexionada", () => {
    // La frase contiene "startled" y el lemma es "startle": sin lematizar, el
    // hueco nunca se dibujaría y la card no funcionaría.
    const r = blankSentence("The noise startled the horses.", { lemma: "startle" });
    expect(r).not.toBeNull();
    expect(r!.before).toBe("The noise ");
    expect(r!.after).toBe(" the horses.");
  });

  it("coloca el hueco sobre la forma observada, no sobre el lemma", () => {
    const r = blankSentence("She runs every morning.", { lemma: "run" });
    expect(r!.before).toBe("She ");
    expect(r!.after).toBe(" every morning.");
  });

  it("devuelve null si la palabra no está en la frase", () => {
    expect(blankSentence("Nothing relevant here.", { lemma: "startle" })).toBeNull();
  });

  it("el hueco cae siempre en un límite de token", () => {
    // `startled` contiene "startle", pero el hueco se dibuja sobre el token
    // entero, no dentro de él.
    const r = blankSentence("The noise startled the horses.", { lemma: "startle" });
    expect(r!.before + "___" + r!.after).toBe("The noise ___ the horses.");
  });

  it("funciona con frases (kind phrase)", () => {
    const r = blankSentence("I gave up after three miles.", { lemma: "give up" });
    expect(r).toBeNull();
  });
});
