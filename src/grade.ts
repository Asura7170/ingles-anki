import type { Ease } from "./db";
import { compareAnswer, normalizeForDiff, type Comparison } from "./diff";
import { identify } from "./identity";

/**
 * Anki NO califica la respuesta escrita: el manual lo dice ("does not change how
 * the cards are answered") y el código no tiene ningún contador. Esto es diseño
 * propio.
 *
 * Un error de una letra en una palabra de 6+ letras indica conocimiento alto, no
 * ignorancia; mandarlo a `Again` castiga al estudiante por un dedo mal puesto.
 * El umbral es configurable (0.8 por defecto) porque la misma tasa de error no
 * debería significar lo mismo en una palabra de 4 letras que en una de 12.
 */
export const DEFAULT_THRESHOLD = 0.8;

export interface GradeResult {
  comparison: Comparison;
  suggested: Ease | null;
}

/** `null` = el usuario no escribió nada; la calificación es manual. */
export function gradeTyping(
  expected: string,
  typed: string,
  threshold = DEFAULT_THRESHOLD,
): GradeResult {
  if (!typed.trim()) return { comparison: compareAnswer(expected, ""), suggested: null };

  // La forma flexiona al mismo lemma ("cries"→"cry"): acierto. El display
  // muestra LO TIPADO en verde, no el lemma: pintar "cry" cuando escribiste
  // "cries" parecía que te cambiaba la respuesta. Probamos vocabulario, no
  // conjugación; cualquier otra entrada sigue el camino de siempre.
  const expectedLemma = identify(expected)?.lemma;
  if (expectedLemma && identify(typed)?.lemma === expectedLemma) {
    const normTyped = normalizeForDiff(typed);
    return {
      comparison: {
        exact: true,
        typedLine: [{ kind: "good", text: normTyped }],
        expectedLine: [{ kind: "good", text: normalizeForDiff(expected) }],
        ok: normTyped.length,
        bad: 0,
        missing: 0,
        ratio: 1,
      },
      suggested: 4,
    };
  }

  const comparison = compareAnswer(expected, typed);
  let suggested: Ease;

  if (comparison.exact) suggested = 4;
  else if (comparison.ratio >= threshold) suggested = 2;
  else suggested = 1;

  return { comparison, suggested };
}

/** Sin sentence de contexto: el typing no es obligatorio (Q30). */
export function hasTypingContext(sentence: string | undefined): boolean {
  return Boolean(sentence && sentence.trim().split(/\s+/).length >= 3);
}
