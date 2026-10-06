import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import type { Ease } from "./db";

/**
 * FSRS-6 vía ts-fsrs (0 dependencias, MIT). No reimplementamos SM-2: FSRS gana
 * en Log Loss frente a SM-2, SM-17, HLR, ACT-R y DASH en el benchmark de
 * open-spaced-repetition.
 *
 * Sin optimizer: los defaults son buenos hasta ~400 repasos reales, y per-itemizar
 * cuesta precisión (FSRS-7 por deck: 0.3489 vs 0.3401 global en el benchmark).
 *
 * ponytail: S_0 siempre con defaults. Si tras ~1000 reviews la retención te
 * parece mala, optimiza `w` con el dataset de open-spaced-repetition — no antes.
 */
const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false });

const RATINGS: Record<Ease, Grade> = {
  1: Rating.Again,
  2: Rating.Hard,
  3: Rating.Good,
  4: Rating.Easy,
};

export function newCard(now = Date.now()): Card {
  return createEmptyCard(now);
}

export function review(card: Card | null, ease: Ease, now = Date.now()): Card {
  return scheduler.next(card ?? createEmptyCard(now), now, RATINGS[ease]).card;
}

/** 0 = no la sabes, 1 = la sabes ahora mismo. Ordenar ascendente = "lo que se me olvida". */
export function retrievability(card: Card | null, now = Date.now()): number {
  return card ? scheduler.get_retrievability(card, now, false) : 0;
}

/** Reset completo. `reviewLog` nunca se borra: es la bitácora. */
export function forget(card: Card, now = Date.now()): Card {
  return scheduler.forget(card, now, true).card;
}

export function isDue(card: Card | null, now = Date.now()): boolean {
  return !card || card.due.getTime() <= now;
}
