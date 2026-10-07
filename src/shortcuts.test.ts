import { describe, expect, it, vi } from "vite-plus/test";
import { makeShortcutHandler, type ShortcutDeps } from "./shortcuts";
import type { Ease } from "./db";

/**
 * `makeShortcutHandler` es una función pura: recibe dependencias y devuelve un
 * handler. Eso permite testearla en `environment: "node"` sin DOM ni jsdom ni
 * happy-dom, que es el motivo de haberla extraído del componente.
 *
 * Lo que aquí se fija son las decisiones de UX que son fáciles de romper al
 * refactorizar sin querer: qué tecla hace qué, y sobre todo qué tecla NO hace
 * nada. Un atajo que empieza a dispararse mientras el usuario escribe es un bug
 * que ningún assert de "funciona" detecta.
 */

type Overrides = Partial<ShortcutDeps>;

function setup(overrides: Overrides = {}) {
  const deps: ShortcutDeps = {
    revealed: false,
    suggested: null,
    sentence: "The noise startled the horses.",
    reveal: vi.fn(),
    advance: vi.fn(),
    play: vi.fn(),
    stopTts: vi.fn(),
    inputRef: { current: null },
    wordRef: { current: { click: vi.fn() } },
    ...overrides,
  };
  const press = (key: string, opts: { typing?: boolean } = {}) =>
    makeShortcutHandler(deps)({
      key,
      target: { tagName: opts.typing ? "INPUT" : "DIV" },
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
  return { deps, press };
}

const wasPrevented = (e: KeyboardEvent) =>
  (e as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault.mock.calls.length >
  0;

describe("voltear la card", () => {
  it("Enter y Espacio revelan", () => {
    for (const key of ["Enter", " "]) {
      const { deps, press } = setup();
      press(key);
      expect(deps.reveal).toHaveBeenCalledOnce();
    }
  });

  it("Escape corta el TTS en cualquier estado", () => {
    for (const revealed of [false, true]) {
      const { deps, press } = setup({ revealed });
      press("Escape");
      expect(deps.stopTts).toHaveBeenCalledOnce();
      expect(deps.reveal).not.toHaveBeenCalled();
    }
  });

  it("ya revelada, Enter NO vuelve a revelar", () => {
    const { deps, press } = setup({ revealed: true });
    press("Enter");
    expect(deps.reveal).not.toHaveBeenCalled();
  });
});

describe("escribir en el campo no dispara atajos", () => {
  it("Espacio con el input presente se escribe, no revela", () => {
    const inputRef = { current: { blur: vi.fn() } };
    const { deps, press } = setup({ inputRef });
    press(" ", { typing: true });
    expect(deps.reveal).not.toHaveBeenCalled();
  });

  it("Espacio SIN input sí revela, porque no hay nada que escribir", () => {
    const { deps, press } = setup({ inputRef: { current: null } });
    press(" ", { typing: true });
    expect(deps.reveal).toHaveBeenCalledOnce();
  });

  it("r y w son letras normales dentro del input", () => {
    const { deps, press } = setup({ revealed: true, wordRef: { current: { click: vi.fn() } } });
    press("r", { typing: true });
    press("w", { typing: true });
    expect(deps.play).not.toHaveBeenCalled();
    expect(deps.wordRef.current!.click).not.toHaveBeenCalled();
  });

  // 1-4 graduán aunque el foco esté en un input: es inocuo porque el input de
  // escritura sólo se monta cuando `!revealed` (Study.tsx:130). Con la card
  // revelada no hay nada que teclear, así que no puede competir con el atajo.
  it("1-4 gradúan sin comprobar el foco", () => {
    const { deps, press } = setup({ revealed: true });
    press("2", { typing: true });
    expect(deps.advance).toHaveBeenCalledWith(2);
  });
});

describe("graduar con 1-4", () => {
  it("cada tecla manda su ease", () => {
    const eases: Ease[] = [1, 2, 3, 4];
    for (const e of eases) {
      const { deps, press } = setup({ revealed: true });
      press(String(e));
      expect(deps.advance).toHaveBeenCalledWith(e as Ease);
    }
  });

  it("sólo con la card revelada", () => {
    const { deps, press } = setup({ revealed: false });
    press("2");
    expect(deps.advance).not.toHaveBeenCalled();
  });

  it("otras teclas no graduán", () => {
    const { deps, press } = setup({ revealed: true });
    for (const k of ["0", "5", "a", "ArrowLeft"]) press(k);
    expect(deps.advance).not.toHaveBeenCalled();
  });
});

describe("Enter en el input confirma la sugerencia", () => {
  it("usa la sugerencia cuando existe", () => {
    const { deps, press } = setup({ revealed: true, suggested: 1 });
    press("Enter", { typing: true });
    expect(deps.advance).toHaveBeenCalledWith(1);
  });

  it("sin sugerencia cae en 3 (Otra vez)", () => {
    const { deps, press } = setup({ revealed: true, suggested: null });
    press("Enter", { typing: true });
    expect(deps.advance).toHaveBeenCalledWith(3);
  });

  it("saca el foco antes de revelar, para que Enter no haga scroll", () => {
    const blur = vi.fn();
    const { press } = setup({ inputRef: { current: { blur } } });
    press("Enter", { typing: true });
    expect(blur).toHaveBeenCalledOnce();
  });
});

describe("reproducir audio", () => {
  it("r pronuncia la frase", () => {
    const { deps, press } = setup({ revealed: true });
    press("r");
    expect(deps.play).toHaveBeenCalledWith("The noise startled the horses.");
  });

  it("R en mayúscula también", () => {
    const { deps, press } = setup({ revealed: true });
    press("R");
    expect(deps.play).toHaveBeenCalledOnce();
  });

  it("sin frase, r no hace nada", () => {
    const { deps, press } = setup({ revealed: true, sentence: undefined });
    press("r");
    expect(deps.play).not.toHaveBeenCalled();
  });

  it("w hace click en el altavoz de la palabra", () => {
    const click = vi.fn();
    const { press } = setup({ revealed: true, wordRef: { current: { click } } });
    press("w");
    expect(click).toHaveBeenCalledOnce();
  });

  it("w sin altavoz montado no lanza", () => {
    const { press } = setup({ revealed: true, wordRef: { current: null } });
    expect(() => press("w")).not.toThrow();
  });
});

describe("el handler preventea sólo lo que consume", () => {
  it("una tecla ignorada deja el scroll intacto", () => {
    const e = {
      key: "q",
      target: { tagName: "DIV" },
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    makeShortcutHandler({} as ShortcutDeps)(e);
    expect(wasPrevented(e)).toBe(false);
  });

  it("una tecla consumida previene el default", () => {
    const { deps } = setup({ revealed: true });
    const e = {
      key: "1",
      target: { tagName: "DIV" },
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    makeShortcutHandler(deps)(e);
    expect(wasPrevented(e)).toBe(true);
  });
});
