import { describe, expect, it } from "vite-plus/test";
import { createEmptyCard, State } from "ts-fsrs";
import { newCard, review, retrievability, isDue, forget } from "./srs";
import type { Ease } from "./db";

/**
 * FSRS-6 vía ts-fsrs. Lo que se verifica aquí NO es el algoritmo (lo hace la
 * librería) sino el contrato que OUR capa asume: cómo mapeamos ease→Rating, qué
 * significa "vencida", y que un reset no destruye la bitácora.
 */

const NOW = Date.UTC(2026, 0, 15);
const day = 86_400_000;

describe("newCard", () => {
  it("nace en estado New con estabilidad cero", () => {
    const c = newCard(NOW);
    expect(c.state).toBe(State.New);
    expect(c.stability).toBe(0);
    expect(c.reps).toBe(0);
  });

  it("no acepta una estabilidad inventada", () => {
    // ponytail: nunca inicializar S alta "porque la sabe". En el siguiente
    // next() el intervalo se dispararía y la palabra desaparecería por años.
    expect(newCard(NOW).stability).toBeLessThan(1);
  });
});

describe("review — mapeo ease → Rating", () => {
  it("Fácil extiende más que Bien, que a su vez más que Difícil", () => {
    const easy = review(createEmptyCard(NOW), 4, NOW);
    const good = review(createEmptyCard(NOW), 3, NOW);
    const hard = review(createEmptyCard(NOW), 2, NOW);
    const again = review(createEmptyCard(NOW), 1, NOW);

    expect(easy.stability).toBeGreaterThan(good.stability);
    expect(good.stability).toBeGreaterThan(hard.stability);
    expect(again.state).toBe(State.Learning);
    expect(again.scheduled_days).toBeLessThan(1);
  });

  it("Otra vez devuelve la card al aprendizaje sin perder la cuenta", () => {
    let c = review(createEmptyCard(NOW), 3, NOW);
    c = review(c, 3, NOW + 10 * day);
    expect(c.state).toBe(State.Review);
    expect(c.reps).toBe(2);

    const lapsed = review(c, 1, NOW + 40 * day);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.reps).toBe(3);
  });

  it("establece el due en el futuro para un acierto", () => {
    const c = review(createEmptyCard(NOW), 3, NOW);
    expect(c.due.getTime()).toBeGreaterThan(NOW);
  });

  it("acepta null y crea la card implícitamente", () => {
    expect(review(null, 3, NOW).state).toBeDefined();
  });

  it("el ease 4 no avanza absurdamente en una palabra nueva", () => {
    // El riesgo documentado de inicializar S alta: FSRS-6 da ~8 días a un Fácil
    // en una card nueva. Acotarlo a un mes documenta que NO le estamos
    // inyectando una estabilidad inventada (que sería años).
    const c = review(createEmptyCard(NOW), 4, NOW);
    expect(c.stability).toBeGreaterThan(1);
    expect(c.stability).toBeLessThan(30);
  });
});

describe('retrievability — "lo que más se me está olvidando"', () => {
  it("una card nueva no se recuerda", () => {
    expect(retrievability(createEmptyCard(NOW), NOW)).toBe(0);
    expect(retrievability(null, NOW)).toBe(0);
  });

  it("decae con el tiempo transcurrido", () => {
    const c = review(createEmptyCard(NOW), 4, NOW);
    const r1 = retrievability(c, NOW + 1 * day);
    const r2 = retrievability(c, NOW + 30 * day);
    expect(r1).toBeGreaterThan(r2);
  });

  it('ordena el caso "terminé el Book 1 y encontré la palabra en un podcast"', () => {
    // Lokeywords: una palabra estable sigue alta tras 3 semanas; una frágil, no.
    const solid = review(review(createEmptyCard(NOW), 4, NOW), 4, NOW + 5 * day);
    const fragile = review(createEmptyCard(NOW), 1, NOW);
    const later = NOW + 25 * day;
    expect(retrievability(solid, later)).toBeGreaterThan(retrievability(fragile, later));
  });

  it("queda en [0, 1]", () => {
    const c = review(createEmptyCard(NOW), 3, NOW);
    for (const d of [0, 1, 7, 100, 3650]) {
      const r = retrievability(c, NOW + d * day);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });
});

describe("isDue", () => {
  it("una card nueva vence de inmediato", () => {
    expect(isDue(createEmptyCard(NOW), NOW)).toBe(true);
    expect(isDue(null, NOW)).toBe(true);
  });

  it("una card agendada no vence hasta su due", () => {
    const c = review(createEmptyCard(NOW), 3, NOW);
    expect(isDue(c, NOW)).toBe(false);
    expect(isDue(c, c.due.getTime() + 1)).toBe(true);
  });
});

describe("forget — reset sin destruir la bitácora", () => {
  it("devuelve la card a New con estabilidad cero", () => {
    const studied = review(review(createEmptyCard(NOW), 3, NOW), 3, NOW + 10 * day);
    const reset = forget(studied, NOW + 20 * day);

    expect(reset.state).toBe(State.New);
    expect(reset.stability).toBe(0);
  });

  it('es el "no la sé — reiniciar historial" del diálogo', () => {
    // La bitácora (reviewLog) vive en otra tabla y nunca se toca: esto sólo
    // reinicia el scheduling.
    const c = review(createEmptyCard(NOW), 4, NOW);
    expect(forget(c, NOW).reps).toBe(0);
  });
});

describe("tipos de Ease", () => {
  it("cubre los 4 botones", () => {
    const eases: Ease[] = [1, 2, 3, 4];
    for (const e of eases) {
      expect(review(createEmptyCard(NOW), e, NOW)).toBeDefined();
    }
  });

  it("newCard acepta el reloj inyectado para que los tests no dependan del sistema", () => {
    expect(newCard(NOW).due.getTime()).toBe(NOW);
  });

  it("en el due la retención es request_retention, no 1", () => {
    // Esta es la lectura correcta y merece estar fijada en un test: en el due la
    // palabra se ha olvidado el 10% por diseño. Hay que llevar la card a Review;
    // en Learning la retencibilidad es 1 porque mandan los pasos de aprendizaje.
    let c = review(createEmptyCard(NOW), 3, NOW);
    c = review(c, 3, NOW + 10 * day);
    expect(c.state).toBe(State.Review);
    expect(retrievability(c, c.due.getTime())).toBeCloseTo(0.9, 2);

    // Justo antes del due todavía se recuerda más.
    expect(retrievability(c, c.due.getTime() - 3600_000)).toBeGreaterThan(0.9);
  });

  it("en Learning la retencibilidad es 1: los pasos mandan sobre la curva", () => {
    // Documenta la diferencia de estado que puede sorprender al ordenar la cola
    // por "lo que más se me está olvidando".
    const learning = review(createEmptyCard(NOW), 3, NOW);
    expect(learning.state).toBe(State.Learning);
    expect(retrievability(learning, NOW)).toBe(1);
  });
});
