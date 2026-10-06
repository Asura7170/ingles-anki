/**
 * Wrapper de speechSynthesis. No es un polyfill: la API de Chrome tiene bugs
 * conocidos que hay que esquivar.
 *
 *   - getVoices() devuelve [] hasta que se puebla asíncronamente, y
 *     `voiceschanged` puede dispararse sin que getVoices() refleje nada.
 *     → polling, no el evento.
 *   - Corta la locución a los ~15 s sin disparar `end` (Chromium P2, abierto
 *     desde 2017). → trocear por frases cortas y encolar a mano.
 *   - cancel() seguido de speak() no hace nada. → delay.
 *   - pause() puede dejar el sintetizador colgado para siempre; sólo cancel()
 *     rescata. → máquina de estado propia, nunca confiar en `.speaking`.
 *   - onboundary sólo dispara en voces locales de escritorio. → localService.
 */

export type TtsState = "idle" | "speaking" | "paused";

let voices: SpeechSynthesisVoice[] = [];
let voicesReady: Promise<void> | null = null;
let state: TtsState = "idle";
let watchdog: ReturnType<typeof setTimeout> | undefined;
let lastCancel = 0;

const listeners = new Set<(s: TtsState) => void>();

function setState(next: TtsState) {
  if (state === next) return;
  state = next;
  for (const fn of listeners) fn(next);
}

export function onTtsState(fn: (s: TtsState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function ttsState(): TtsState {
  return state;
}

function loadVoices(): Promise<void> {
  if (voicesReady) return voicesReady;
  voicesReady = new Promise<void>((resolve) => {
    let tries = 0;
    const attempt = () => {
      const all = speechSynthesis.getVoices();
      if (all.length > 0 || tries > 50) {
        // localService primero: app offline y onboundary fiable.
        voices = all
          .filter((v) => v.lang.startsWith("en"))
          .sort((a, b) => Number(b.localService) - Number(a.localService));
        resolve();
        return;
      }
      tries++;
      setTimeout(attempt, 50);
    };
    speechSynthesis.addEventListener("voiceschanged", attempt, { once: true });
    attempt();
  });
  return voicesReady;
}

export function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  return (
    voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith(lang.slice(0, 2)))
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Trocear para no pasar de ~180 caracteres: ~8 s, muy por debajo del corte. */
function chunkSentences(text: string, max = 180): string[] {
  const parts = text.split(/(?<=[.!?…])\s+/);
  const out: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };

  for (const part of parts) {
    // Un segmento sin puntuación puede exceder el máximo por sí solo (una
    // transcripción sin puntos). Cortar en límites de palabra; si una palabra
    // es enorme, se acepta el corte antes que locutar 20 s de golpe.
    if (part.length > max) {
      flush();
      let wordBuf = "";
      for (const word of part.split(/\s+/).filter(Boolean)) {
        const next = wordBuf ? `${wordBuf} ${word}` : word;
        if (wordBuf && next.length > max) {
          out.push(wordBuf);
          wordBuf = word;
        } else {
          wordBuf = next;
        }
      }
      buf = wordBuf;
      continue;
    }

    const candidate = buf ? `${buf} ${part}` : part;
    if (buf && candidate.length > max) {
      flush();
      // Tras vaciar, `candidate` ya no vale: hay que empezar por `part`.
      buf = part;
    } else {
      buf = candidate;
    }
  }

  flush();
  return out.length > 0 ? out : [text];
}

function speakOne(text: string, lang: string, rate: number): Promise<void> {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? lang;
    u.rate = rate;
    u.pitch = 1;
    u.volume = 1;

    setState("speaking");
    const budget = Math.max(5000, text.length * 130);
    const done = () => {
      clearTimeout(watchdog);
      setState("idle");
      resolve();
    };
    watchdog = setTimeout(() => {
      stop();
      resolve();
    }, budget);
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  });
}

export async function speak(
  text: string,
  opts: { lang?: string; rate?: number } = {},
): Promise<void> {
  if (!text.trim()) return;
  await loadVoices();
  stop();
  await sleep(lastCancel ? 90 : 0);
  for (const chunk of chunkSentences(text))
    await speakOne(chunk, opts.lang ?? "en-US", opts.rate ?? 1);
}

export function stop(): void {
  clearTimeout(watchdog);
  lastCancel = Date.now();
  try {
    speechSynthesis.cancel();
  } catch {
    // cancel() lanza en algunos estados; el watchdog ya está limpio.
  }
  setState("idle");
}

/** Sólo para UI: las voces locales son las únicas con onboundary fiable. */
export async function listVoices(): Promise<SpeechSynthesisVoice[]> {
  await loadVoices();
  return voices;
}

/** Sólo para tests: la caché de voces es de módulo y hay que poder limpiarla. */
export function __resetTtsCache(): void {
  voicesReady = null;
  voices = [];
  state = "idle";
  clearTimeout(watchdog);
  listeners.clear();
}
