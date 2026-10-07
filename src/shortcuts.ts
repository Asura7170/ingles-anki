/**
 * Atajos de teclado de la sesión de estudio, fuera del componente.
 *
 * Estaba dentro de `Study` y por eso arrastraba su complejidad al padre: la
 * función no usa ningún hook, sólo decide a qué callback llamar según la tecla
 * y si el foco está en un campo de texto. Separarla la deja como una función
 * pura, que es justo lo que la hace testeable sin `jsdom`.
 */

import { useEffect } from "react";
import { db } from "./db";
import type { LlmConfig } from "./llm";
import type { Ease } from "./db";

export interface ShortcutDeps {
  revealed: boolean;
  suggested?: Ease | null;
  /** Frase a pronunciar con la tecla R. Sin frase, la tecla no hace nada. */
  sentence?: string;
  reveal: () => void;
  advance: (ease: Ease) => void;
  play: (text: string) => void;
  stopTts: () => void;
  inputRef: { current: { blur(): void } | null };
  /** Click en el altavoz de la palabra: la tecla W es su atajo. */
  wordRef: { current: { click(): void } | null };
}

/**
 * Traduce la frase de la card la primera vez que se voltea, no antes: es una
 * llamada de red y bloquearla al abrir sesión retrasaría el primer render.
 *
 * Se relee del senses justo antes de escribir en vez de usar el `sense` que
 * capturó el efecto: si el usuario avanzó de card mientras traducíamos, el
 * closure viejo escribiría la traducción sobre el nodo equivocado.
 */
export function useSentenceTranslation(deps: {
  revealed: boolean;
  sentence?: string;
  nodeId?: number;
  /** Ya traducida: no se vuelve a pedir. */
  done: boolean;
  llm: LlmConfig;
  targetLang: string;
}): void {
  const { revealed, sentence, nodeId, done, llm, targetLang } = deps;
  useEffect(() => {
    if (!revealed || !sentence || done || nodeId === undefined || !llm.model) return;
    let cancelled = false;
    void (async () => {
      const { translateSentence } = await import("./translate");
      try {
        const t = await translateSentence(llm, sentence, targetLang);
        if (cancelled || !t) return;
        const fresh = await db.senses.where("nodeId").equals(nodeId).first();
        if (fresh) await db.senses.update(fresh.id!, { sentenceTranslation: t });
      } catch {
        // Sin traducción de frase: la card sigue siendo útil.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revealed, sentence, nodeId, done, llm, targetLang]);
}

const isTypingTarget = (e: KeyboardEvent): boolean => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
};

/**
 * Entrada: `1`-`4` avanzan por la sugerencia, `r` repite la frase, `w` la palabra,
 * `Enter`/`Espacio` voltean y `Enter` sobre el campo confirma, `Escape` corta el
 * TTS. Los atajos numéricos y `r`/`w` se ignoran mientras se escribe, para que
 * `w` pueda seguir siendo una letra normal dentro de la palabra.
 */
export function makeShortcutHandler(deps: ShortcutDeps): (e: KeyboardEvent) => void {
  return (e) => {
    const typing = isTypingTarget(e);

    if (e.key === "Escape") {
      deps.stopTts();
      return;
    }
    if (!deps.revealed && isFlipKey(e.key)) {
      // El espacio tiene que poder escribirse si el foco está en el input.
      if (typing && e.key === " " && deps.inputRef.current) return;
      e.preventDefault();
      // `Enter` submits y haría scroll: se saca el foco antes de revelar.
      if (typing && e.key === "Enter") deps.inputRef.current?.blur();
      deps.reveal();
      return;
    }
    if (deps.revealed && e.key === "Enter" && typing) {
      e.preventDefault();
      deps.advance(deps.suggested ?? 3);
      return;
    }
    const ease = gradeKey(e.key);
    if (deps.revealed && ease) {
      e.preventDefault();
      deps.advance(ease);
      return;
    }
    if (!typing && e.key.toLowerCase() === "r" && deps.sentence) {
      e.preventDefault();
      deps.play(deps.sentence);
      return;
    }
    if (!typing && e.key.toLowerCase() === "w") {
      e.preventDefault();
      deps.wordRef.current?.click();
    }
  };
}

/** `1`..`4` mapeadas a las cuatro ease de FSRS, en el orden de los botones. */
const gradeKey = (key: string): Ease | undefined =>
  /^[1-4]$/.test(key) ? (Number(key) as Ease satisfies Ease) : undefined;

const isFlipKey = (key: string) => key === "Enter" || key === " ";
