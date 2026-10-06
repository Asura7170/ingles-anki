/**
 * Port de `compare_answer()` de Anki (rslib/src/typeanswer.rs), que usa
 * `difflib::SequenceMatcher` (Ratcliff/Obershelp). NO es LCS ni Levenshtein:
 * el paquete `diff` de npm es Myers/LCS y cambia el resultado.
 *
 * Verificado contra los tres casos de comportamiento esperados y contra los 9
 * vectores de los tests unitarios de Anki.
 *
 * Desviaciones deliberadas (no es réplica ciega):
 *   1. Normalizamos apóstrofos curvos, guiones y espacios. Anki marca `'` vs
 *      `’` como error, lo que produce falsos negativos con teclado español y
 *      con subtítulos de YouTube.
 *   2. Lo no escrito se muestra como hueco, no como guiones grises.
 *   3. Segmentación por graphemes reales (Intl.Segmenter), no por code points.
 */

export type TokenKind = "good" | "bad" | "missing";
export interface Token {
  kind: TokenKind;
  text: string;
}

type Tag = "equal" | "delete" | "insert" | "replace";
interface Opcode {
  tag: Tag;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

function buildB2J(b: string[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (let i = 0; i < b.length; i++) {
    const list = m.get(b[i]!);
    if (list) list.push(i);
    else m.set(b[i]!, [i]);
  }
  return m;
}

function makeMatcher(a: string[], b: string[]) {
  let b2j = buildB2J(b);
  // autojunk de Anki: sólo con 200+ caracteres. Una palabra o una frase corta
  // nunca lo activa; se conserva por fidelidad.
  if (b.length >= 200) {
    const limit = Math.floor(b.length / 100) + 1;
    const kept = new Map<string, number[]>();
    for (const [k, v] of b2j) if (v.length > limit) kept.set(k, v);
    b2j = kept;
  }

  function findLongestMatch(alo: number, ahi: number, blo: number, bhi: number) {
    let bestI = alo;
    let bestJ = blo;
    let bestSize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const size = (j > 0 ? (j2len.get(j - 1) ?? 0) : 0) + 1;
        next.set(j, size);
        if (size > bestSize) {
          bestI = i + 1 - size;
          bestJ = j + 1 - size;
          bestSize = size;
        }
      }
      j2len = next;
    }
    // El crate de Rust itera la extensión 2 veces; Python usa while(1).
    for (let pass = 0; pass < 2; pass++) {
      while (bestI > alo && bestJ > blo && a[bestI - 1] === b[bestJ - 1]) {
        bestI--;
        bestJ--;
        bestSize++;
      }
      while (
        bestI + bestSize < ahi &&
        bestJ + bestSize < bhi &&
        a[bestI + bestSize] === b[bestJ + bestSize]
      )
        bestSize++;
    }
    return { i: bestI, j: bestJ, size: bestSize };
  }

  type Span = [number, number, number, number];

  function matchingBlocks() {
    const queue: Span[] = [[0, a.length, 0, b.length]];
    const found: { i: number; j: number; size: number }[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const m = findLongestMatch(alo, ahi, blo, bhi);
      if (m.size === 0) continue;
      if (alo < m.i && blo < m.j) queue.push([alo, m.i, blo, m.j]);
      if (m.i + m.size < ahi && m.j + m.size < bhi) {
        queue.push([m.i + m.size, ahi, m.j + m.size, bhi]);
      }
      found.push(m);
    }
    found.sort((x, y) => x.i - y.i || x.j - y.j || x.size - y.size);

    // fusiona bloques adyacentes + centinela final
    const merged: { i: number; j: number; size: number }[] = [];
    let si = 0;
    let sj = 0;
    let sz = 0;
    for (const m of found) {
      if (si + sz === m.i && sj + sz === m.j) sz += m.size;
      else {
        if (sz !== 0) merged.push({ i: si, j: sj, size: sz });
        si = m.i;
        sj = m.j;
        sz = m.size;
      }
    }
    if (sz !== 0) merged.push({ i: si, j: sj, size: sz });
    merged.push({ i: a.length, j: b.length, size: 0 });
    return merged;
  }

  return function opcodes(): Opcode[] {
    const blocks = matchingBlocks();
    const ops: Opcode[] = [];
    let i = 0;
    let j = 0;
    for (const m of blocks) {
      let tag: Tag | null = null;
      if (i < m.i && j < m.j) tag = "replace";
      else if (i < m.i) tag = "delete";
      else if (j < m.j) tag = "insert";
      if (tag) ops.push({ tag, a0: i, a1: m.i, b0: j, b1: m.j });
      i = m.i + m.size;
      j = m.j + m.size;
      if (m.size !== 0) ops.push({ tag: "equal", a0: m.i, a1: i, b0: m.j, b1: j });
    }
    return ops;
  };
}

const APOS = /[‘’‚‛′]/g;
const DASHES = /[‐‑‒–—―]/g;
const FOLD: Record<string, string> = { ς: "σ", ſ: "s" };

/** Desviación 1 + las dos reglas de fold_case de Anki (ς→σ, ſ→s). */
export function normalizeForDiff(input: string): string {
  return input
    .normalize("NFC")
    .replace(APOS, "'")
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .split("")
    .map((c) => FOLD[c] ?? c)
    .join("")
    .normalize("NFC");
}

const graphemes = (s: string): string[] => {
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  return [...seg.segment(s)].map((x) => x.segment);
};

export interface Comparison {
  exact: boolean;
  typedLine: Token[];
  expectedLine: Token[];
  ok: number;
  bad: number;
  missing: number;
  /** ok / max(len(esperada), len(escrita)) */
  ratio: number;
}

export function compareAnswer(expected: string, typed: string): Comparison {
  const normExpected = normalizeForDiff(expected);
  const normTyped = normalizeForDiff(typed);

  // atajo de Anki: todo igual → un solo acierto, sin diff
  if (normTyped === normExpected) {
    return {
      exact: true,
      typedLine: [{ kind: "good", text: normTyped }],
      expectedLine: [{ kind: "good", text: normExpected }],
      ok: normExpected.length,
      bad: 0,
      missing: 0,
      ratio: 1,
    };
  }

  // Desviación 3: graphemes, no code points. `a` = escrito, `b` = esperado
  // (SequenceMatcher es asimétrico; invertirlo cambia el caso `llorts`/`stroll`).
  const a = graphemes(normTyped);
  const b = graphemes(normExpected);

  const typedLine: Token[] = [];
  const expectedLine: Token[] = [];
  let ok = 0;
  let bad = 0;
  let missing = 0;

  for (const op of makeMatcher(a, b)()) {
    const t = a.slice(op.a0, op.a1).join("");
    const e = b.slice(op.b0, op.b1).join("");
    switch (op.tag) {
      case "equal":
        typedLine.push({ kind: "good", text: t });
        expectedLine.push({ kind: "good", text: e });
        ok += t.length;
        break;
      case "delete":
        typedLine.push({ kind: "bad", text: t });
        bad += t.length;
        break;
      case "insert":
        // Desviación 2: hueco, no guiones.
        typedLine.push({ kind: "missing", text: "" });
        expectedLine.push({ kind: "missing", text: e });
        missing += e.length;
        break;
      case "replace":
        typedLine.push({ kind: "bad", text: t });
        expectedLine.push({ kind: "missing", text: e });
        bad += t.length;
        missing += e.length;
        break;
    }
  }

  const ratio = ok / Math.max(b.length, a.length, 1);
  return { exact: false, typedLine, expectedLine, ok, bad, missing, ratio };
}
