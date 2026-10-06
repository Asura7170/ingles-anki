import { describe, expect, it } from "vite-plus/test";
import { compareAnswer, normalizeForDiff } from "./diff";

/**
 * Port de `compare_answer()` de Anki (rslib/src/typeanswer.rs), que usa
 * `difflib::SequenceMatcher` (Ratcliff/Obershelp). NO es LCS ni Levenshtein.
 *
 * El Caso 3 es el que discrimina: LCS puro también marcaría o/r/t/s.
 */

const render = (r: ReturnType<typeof compareAnswer>) =>
  r.typedLine
    .map((t) => (t.kind === "good" ? `✓${t.text}` : t.kind === "bad" ? `✗${t.text}` : `_${t.text}`))
    .join("");

describe("Caso 1 — un carácter equivocado", () => {
  const r = compareAnswer("stroll", "strall");

  it("reconoce los 5 aciertos y el 1 fallo", () => {
    expect(r.exact).toBe(false);
    expect(r.ok).toBe(5);
    expect(r.bad).toBe(1);
  });

  it("marca sólo la `a` en rojo", () => {
    expect(r.typedLine.map((t) => t.kind).join(",")).toBe("good,bad,good");
    expect(render(r)).toBe("✓str✗a✓ll");
  });

  it("conserva lo que el usuario escribió", () => {
    expect(r.typedLine.map((t) => t.text).join("")).toBe("strall");
  });

  it("ratio 5/6", () => {
    expect(r.ratio).toBeCloseTo(5 / 6, 10);
  });
});

describe("Caso 2 — caracteres extra intercalados", () => {
  const r = compareAnswer("stroll", "s1t2r3o4l5l");

  it("acepta las 6 letras en su posición", () => {
    expect(r.ok).toBe(6);
    expect(r.typedLine.filter((t) => t.kind === "good")).toHaveLength(6);
  });

  it("rechaza los 5 números", () => {
    expect(r.bad).toBe(5);
    expect(r.typedLine.filter((t) => t.kind === "bad")).toHaveLength(5);
  });

  it("no hay caracteres faltantes", () => {
    expect(r.missing).toBe(0);
  });
});

describe("Caso 3 — bloque contiguo desplazado (discrimina el algoritmo)", () => {
  const r = compareAnswer("stroll", "llorts");

  it("sólo reconoce el bloque más largo: `ll`", () => {
    expect(
      r.typedLine
        .filter((t) => t.kind === "good")
        .map((t) => t.text)
        .join(""),
    ).toBe("ll");
  });

  it("el resto queda en rojo", () => {
    expect(
      r.typedLine
        .filter((t) => t.kind === "bad")
        .map((t) => t.text)
        .join(""),
    ).toBe("orts");
  });

  it("LCS puro marcaría también o/r/t/s — aquí NO", () => {
    // Si el algoritmo fuera LCS, `good` tendría 5 caracteres, no 2.
    expect(r.ok).toBe(2);
  });

  it("el hueco de lo no escrito es vacío, no guiones (desviación 2)", () => {
    expect(r.typedLine.some((t) => t.kind === "missing" && t.text === "")).toBe(true);
  });
});

describe("coincidencia exacta", () => {
  it("devuelve todo verde sin diff", () => {
    const r = compareAnswer("run", "run");
    expect(r.exact).toBe(true);
    expect(r.typedLine).toEqual([{ kind: "good", text: "run" }]);
    expect(r.ratio).toBe(1);
    expect(r.bad).toBe(0);
    expect(r.missing).toBe(0);
  });

  it("la entrada vacía no es exacta", () => {
    const r = compareAnswer("run", "");
    expect(r.exact).toBe(false);
    expect(r.missing).toBeGreaterThan(0);
  });
});

describe("normalización (desviación 1: sin falsos negativos)", () => {
  it.each([
    ["don't", "don’t", "apóstrofo curvo"],
    ["well-known", "well–known", "guion largo"],
    ["Run", "run", "mayúsculas"],
    ["RUN", "run", "todo mayúsculas"],
    ["give  up", "give up", "espacios duplicados"],
    ["  run  ", "run", "espacios en los extremos"],
    ["Straße", "STRASSE", "ß vs SS: NO se iguala (1-a-1, como Anki)"],
  ])("normalizeForDiff / compara %j vs %j — %s", (expected, typed, _why) => {
    // El último caso documenta una limitación, no un fix: por eso se separa.
    if (_why.includes("NO se iguala")) {
      expect(compareAnswer(expected, typed).exact).toBe(false);
    } else {
      expect(compareAnswer(expected, typed).exact).toBe(true);
    }
  });

  it("normaliza NBSP a espacio", () => {
    expect(normalizeForDiff("a b")).toBe("a b");
  });
});

describe("graphemes, no code points (desviación 3)", () => {
  it("un emoji cuenta como un carácter", () => {
    const r = compareAnswer("ok👨", "ok👨");
    expect(r.exact).toBe(true);
  });

  it("un emoji con ZWJ no se fragmenta en diff", () => {
    const r = compareAnswer("👨‍👩‍👦", "👨‍👩‍👦");
    expect(r.exact).toBe(true);
  });

  it("un acento combinante se compara como un grapheme", () => {
    // NFC: e + U+0301 se colapsa a é antes de comparar.
    expect(compareAnswer("café", "café").exact).toBe(true);
  });
});

describe("frases como objetivo", () => {
  it("un espacio omitido cuenta como faltante, no como sobra", () => {
    // El opcode es `insert` (esperado > escrito): va a `missing`, no a `bad`.
    const r = compareAnswer("give up", "giveup");
    expect(r.exact).toBe(false);
    expect(r.missing).toBe(1);
    expect(r.bad).toBe(0);
  });

  it("acepta el espacio correcto", () => {
    expect(compareAnswer("give up", "give up").exact).toBe(true);
  });
});
