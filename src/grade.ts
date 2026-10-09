import type { Ease } from "./db";
import { compareAnswer, type Comparison } from "./diff";

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

  // Sin atajos por lemma: vale la forma exacta del contexto ("cries"), no el
  // infinitivo ("cry" da "cr" verde + "y" roja). La respuesta esperada ya es
  // la palabra de la frase (store la calcula), así que aquí no hay nada que
  // perdonar.
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
