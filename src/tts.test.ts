import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  speak,
  stop,
  listVoices,
  pickVoice,
  ttsState,
  onTtsState,
  __resetTtsCache,
  type TtsState,
} from "./tts";

/**
 * speechSynthesis tiene bugs abiertos en Chromium desde 2017. Aquí se verifica
 * el CONTRATO del wrapper, no el motor de voz del sistema: las voces locales de
 * escritorio son las únicas con onboundary fiable, y eso no se puede testear sin
 * un SO real.
 */

type Utt = {
  text: string;
  onend?: () => void;
  onerror?: () => void;
  lang: string;
  rate: number;
  voice?: SpeechSynthesisVoice;
};

let spoken: Utt[] = [];
let listeners: [string, () => void][] = [];
let voicesValue: SpeechSynthesisVoice[] = [];
let cancelCalls = 0;

class FakeUtterance {
  text = "";
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  voice?: SpeechSynthesisVoice;
  onend?: () => void;
  onerror?: () => void;
  constructor(text: string) {
    this.text = text;
    spoken.push(this as unknown as Utt);
  }
}

function install({ voices }: { voices?: SpeechSynthesisVoice[] } = {}) {
  voicesValue = voices ?? [
    {
      lang: "en-US",
      name: "Microsoft Jenny",
      localService: true,
      default: true,
      voiceURI: "jenny",
      lang_default: true,
    } as SpeechSynthesisVoice,
    {
      lang: "es-ES",
      name: "Microsoft Helena",
      localService: true,
      default: false,
      voiceURI: "helena",
      lang_default: true,
    } as SpeechSynthesisVoice,
  ];
  spoken = [];
  listeners = [];
  cancelCalls = 0;

  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => voicesValue,
    addEventListener: (type: string, fn: () => void) => listeners.push([type, fn]),
    removeEventListener: () => {},
    cancel: () => {
      cancelCalls++;
      // En Chrome cancel() deja el sintetizador colgado un instante: `speak()`
      // inmediatamente después no hace nada.
    },
    speak: (u: Utt) => {
      // La API real encola; aquí completamos la locución al microtask siguiente
      // para no depender del reloj.
      queueMicrotask(() => u.onend?.());
    },
    speaking: false,
  });
}

beforeEach(() => {
  __resetTtsCache();
  install();
});
afterEach(() => {
  __resetTtsCache();
  vi.restoreAllMocks();
});

const finish = async (n = 0) => {
  for (let i = 0; i <= n; i++) await new Promise((r) => setTimeout(r, 5));
};

describe("carga de voces", () => {
  it("filtra a inglés", async () => {
    const voices = await listVoices();
    expect(voices.every((v) => v.lang.startsWith("en"))).toBe(true);
    expect(voices).toHaveLength(1);
  });

  it("prefiere locales sobre remotas", async () => {
    install({
      voices: [
        {
          lang: "en-US",
          name: "Remote",
          localService: false,
          default: false,
          voiceURI: "r",
          lang_default: true,
        } as SpeechSynthesisVoice,
        {
          lang: "en-US",
          name: "Local",
          localService: true,
          default: true,
          voiceURI: "l",
          lang_default: true,
        } as SpeechSynthesisVoice,
      ],
    });
    expect((await listVoices())[0]!.name).toBe("Local");
  });

  it("tolera que getVoices() devuelva [] al principio", async () => {
    // voiceschanged puede dispararse sin que getVoices() refleje nada:
    // por eso el wrapper hace polling en vez de confiar en el evento.
    voicesValue = [];
    const p = listVoices();
    setTimeout(() => {
      voicesValue = [
        {
          lang: "en-GB",
          name: "Later",
          localService: true,
          default: true,
          voiceURI: "g",
          lang_default: true,
        } as SpeechSynthesisVoice,
      ];
    }, 120);
    expect((await p)[0]!.name).toBe("Later");
  });

  it("no se cuelga si nunca llegan voces", async () => {
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel: () => {},
      speak: () => {},
    });
    await expect(listVoices()).resolves.toEqual([]);
  }, 10000);

  it("pickVoice hace fallback por idioma base", async () => {
    await listVoices();
    expect(pickVoice("en-US")?.name).toBe("Microsoft Jenny");
    expect(pickVoice("en-AU")?.name).toBe("Microsoft Jenny");
    expect(pickVoice("ja-JP")).toBeUndefined();
  });
});

describe("speak", () => {
  it("locuta el texto", async () => {
    await speak("run");
    expect(spoken.map((u) => u.text)).toEqual(["run"]);
    expect(ttsState()).toBe("idle");
  });

  it("aplica el acento y la velocidad pedidos", async () => {
    await speak("run", { lang: "en-US", rate: 0.8 });
    expect(spoken[0]!.rate).toBe(0.8);
    expect(spoken[0]!.voice?.name).toBe("Microsoft Jenny");
  });

  it("trocea por frases para no pasar del corte de 15 s", async () => {
    // Una frase de 400 caracteres ≈ 20 s de habla: sin trocear, Chrome la corta
    // en silencio y sin disparar `end`. El contrato que importa es el máximo por
    // chunk, no el número de chunks.
    await speak("a".repeat(100) + ". " + "b".repeat(100) + ". " + "c".repeat(100) + ". ");
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.every((u) => u.text.length <= 200)).toBe(true);
    expect(
      spoken
        .map((u) => u.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    ).toContain("aaa");
  });

  it("trocea también una frase larguísima sin puntuación", async () => {
    await speak("word ".repeat(80));
    expect(spoken.length).toBeGreaterThan(1);
  });

  it("ignora texto vacío", async () => {
    await speak("   ");
    expect(spoken).toHaveLength(0);
  });

  it("cancel() antes de hablar, y con margen", async () => {
    // cancel() seguido de speak() sin delay no hace nada en Chrome.
    await speak("one");
    await speak("two");
    expect(cancelCalls).toBeGreaterThanOrEqual(2);
    expect(spoken.map((u) => u.text)).toEqual(["one", "two"]);
  });
});

describe("máquina de estados", () => {
  it("avisa a los suscriptores", async () => {
    const seen: TtsState[] = [];
    const off = onTtsState((s) => seen.push(s));

    await speak("run");
    off();

    expect(seen).toContain("speaking");
    expect(ttsState()).toBe("idle");
  });

  it("unsubscribe detiene los avisos", async () => {
    const seen: TtsState[] = [];
    const off = onTtsState((s) => seen.push(s));
    off();
    await speak("run");
    expect(seen).toHaveLength(0);
  });

  it("nunca confío en speechSynthesis.speaking", async () => {
    // El fake dice `speaking: false` siempre, y aun así el wrapper reporta
    // 'speaking' mientras locuta: ése es el punto.
    const seen: TtsState[] = [];
    onTtsState((s) => seen.push(s));
    await speak("run");
    expect(seen).toContain("speaking");
  });
});

describe("stop y watchdog", () => {
  it("stop limpia el estado", async () => {
    await speak("run");
    stop();
    expect(ttsState()).toBe("idle");
    expect(cancelCalls).toBeGreaterThan(0);
  });

  it("el watchdog rescata si `end` nunca llega", async () => {
    // Chrome se cuelga y no dispara `end`: sin watchdog la card se queda en
    // 'speaking' para siempre.
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => voicesValue,
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel: () => {
        cancelCalls++;
      },
      speak: () => {}, // nunca llama onend
    });

    await speak("run", { rate: 1 });
    await finish(2);
    expect(ttsState()).toBe("idle");
    expect(cancelCalls).toBeGreaterThan(0);
  }, 20000);

  it("un error del motor también cierra la card", async () => {
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => voicesValue,
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel: () => {},
      speak: (u: Utt) => queueMicrotask(() => u.onerror?.()),
    });
    await speak("run");
    expect(ttsState()).toBe("idle");
  });
});
