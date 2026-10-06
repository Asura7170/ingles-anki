import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { translateBatch, translateSentence, type TranslationUnit } from "./translate";
import type { LlmConfig } from "./llm";

/**
 * La parte donde los lotes se rompen en producción: truncamiento, omisiones con
 * JSON válido, y palabras inventadas. El modo de fallo más caro no es que
 * falle — es que devuelva 200 con menos entradas y el mazo parezca completo.
 */

const cfg: LlmConfig = { baseUrl: "http://localhost:1234/v1", apiKey: "", model: "test-model" };

const units = (words: string[]): TranslationUnit[] =>
  words.map((w, i) => ({
    id: `L${String(i + 1).padStart(4, "0")}`,
    word: w,
    kind: "word" as const,
  }));

afterEach(() => vi.restoreAllMocks());

/** Encola una respuesta por llamada, en orden. */
function queueFetch(bodies: (string | null)[]) {
  const fn = vi.fn();
  for (const b of bodies) {
    fn.mockResolvedValueOnce(
      b === null
        ? new Response("no json", { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: b } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

const okPayload = (items: [string, string][]) =>
  JSON.stringify({
    items: items.map(([id, t]) => ({ id, translations: [t] })),
    total: items.length,
  });

describe("translateBatch — camino feliz", () => {
  it("traduce un lote y mapea por id, no por posición", async () => {
    // Respuesta desordenada a propósito: el id es la única clave fiable.
    queueFetch([
      okPayload([
        ["L0002", "correr"],
        ["L0001", "estudiar"],
      ]),
    ]);
    const got = await translateBatch(cfg, units(["run", "study"]), "español");

    expect(got.get("L0001")).toEqual(["estudiar"]);
    expect(got.get("L0002")).toEqual(["correr"]);
  });

  it("acepta hasta 3 traducciones por palabra", async () => {
    queueFetch([
      JSON.stringify({
        items: [{ id: "L0001", translations: ["correr", "cursar", "ejecutar", "ignorar"] }],
        total: 1,
      }),
    ]);
    const got = await translateBatch(cfg, units(["run"]), "español");
    expect(got.get("L0001")).toHaveLength(3);
  });

  it("descarta entradas vacías o no-string", async () => {
    queueFetch([
      JSON.stringify({
        items: [
          { id: "L0001", translations: ["  correr  ", "", null, 42] },
          { id: "L0002", translations: "no es un array" },
        ],
        total: 2,
      }),
      // L0002 quedó sin traducciones válidas → se reintenta sólo ella.
      okPayload([["L0002", "estudiar"]]),
    ]);
    const got = await translateBatch(cfg, units(["run", "study"]), "español");
    expect(got.get("L0001")).toEqual(["correr"]);
    // El 42 y el vacío se filtran, pero la palabra sí se recupera en el reintento.
    expect(got.get("L0002")).toEqual(["estudiar"]);
  });

  it("filtra traducciones no-string sin perder la palabra", async () => {
    queueFetch([
      JSON.stringify({ items: [{ id: "L0001", translations: [null, 42, {}] }], total: 1 }),
      okPayload([["L0001", "correr"]]),
    ]);
    const got = await translateBatch(cfg, units(["run"]), "español");
    expect(got.get("L0001")).toEqual(["correr"]);
  });
});

describe("translateBatch — palabras inventadas", () => {
  it("descarta una palabra que nunca se pidió", async () => {
    queueFetch([
      JSON.stringify({
        items: [
          { id: "L0001", translations: ["correr"] },
          { id: "L9999", translations: ["fantasma"] },
        ],
        total: 2,
      }),
    ]);
    const got = await translateBatch(cfg, units(["run"]), "español");
    expect(got.has("L9999")).toBe(false);
    expect(got.size).toBe(1);
  });
});

describe("translateBatch — omisiones con JSON válido (el peor caso)", () => {
  it("reintenta sólo las palabras que faltan", async () => {
    queueFetch([
      // Primera llamada: omite L0002 y declara total=1 cuando_ARRAY tiene 2.
      JSON.stringify({
        items: [{ id: "L0001", translations: ["correr"] }],
        total: 1,
      }),
      // Reintento quirúrgico: sólo se le pide lo que falta.
      okPayload([["L0002", "estudiar"]]),
    ]);

    const got = await translateBatch(cfg, units(["run", "study"]), "español");
    expect(got.get("L0001")).toEqual(["correr"]);
    expect(got.get("L0002")).toEqual(["estudiar"]);

    const prompts = vi
      .mocked(fetch)
      .mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).messages);
    expect(prompts[0]!.at(-1)!.content).toContain("L0001");
    expect(prompts[1]!.at(-1)!.content).toContain("L0002");
    expect(prompts[1]!.at(-1)!.content).not.toContain("L0001");
  });

  it("detecta que el modelo se perdió la cuenta", async () => {
    // array de 2, total=1, y ninguna falta: la inconsistencia debe forzar halving.
    queueFetch([
      JSON.stringify({
        items: [
          { id: "L0001", translations: ["a"] },
          { id: "L0002", translations: ["b"] },
        ],
        total: 1,
      }),
    ]);
    const fn = vi.mocked(fetch);
    await expect(translateBatch(cfg, units(["run", "study"]), "español")).resolves.toBeInstanceOf(
      Map,
    );
    expect(fn).toHaveBeenCalled();
  });
});

describe("translateBatch — JSON inválido → halving", () => {
  it("parte el lote a la mitad y reintenta", async () => {
    // 1ª llamada: JSON inválido para el lote entero → halving.
    // 2ª y 3ª: cada mitad por separado responde bien.
    queueFetch([null, okPayload([["L0001", "correr"]]), okPayload([["L0002", "estudiar"]])]);
    const got = await translateBatch(cfg, units(["run", "study"]), "español");

    expect(got.get("L0001")).toEqual(["correr"]);
    expect(got.get("L0002")).toEqual(["estudiar"]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("con una sola palabra, el error se propaga", async () => {
    queueFetch([null, null]);
    await expect(translateBatch(cfg, units(["run"]), "español")).rejects.toThrow();
  });

  it("rechaza una respuesta sin array `items`", async () => {
    queueFetch([JSON.stringify({ total: 0 })]);
    await expect(translateBatch(cfg, units(["run"]), "español")).rejects.toThrow(/items/);
  });
});

describe("translateBatch — presupuesto de tokens", () => {
  it("el lote de 500 pide exactamente 8k, no el máximo del modelo", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      id: `L${String(i + 1).padStart(4, "0")}`,
      word: `w${i}`,
      kind: "word" as const,
    }));
    queueFetch([okPayload(many.map((u) => [u.id, "t"]))]);

    await translateBatch(cfg, many, "español");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);

    // 500 × 20 + 512 = 10512 → clampeado a 8192. OpenRouter devolvería 402 si
    // mandáramos el tope real del modelo.
    expect(body.max_tokens).toBe(8192);
  });

  it("el presupuesto crece con el lote pero respeta el techo", () => {
    const budget = (n: number) => Math.min(8192, n * 20 + 512);
    expect(budget(10)).toBe(712);
    expect(budget(500)).toBe(8192);
    expect(budget(4000)).toBe(8192);
  });
});

describe("translateBatch — partición en lotes", () => {
  it("parte >500 palabras en varias llamadas", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      id: `L${String(i + 1).padStart(4, "0")}`,
      word: `w${i}`,
      kind: "word" as const,
    }));
    const first = many.slice(0, 500);
    queueFetch([okPayload(first.map((u) => [u.id, "t"])), okPayload([["L0501", "t"]])]);

    const got = await translateBatch(cfg, many, "español");
    expect(got.size).toBe(501);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("informa el progreso", async () => {
    queueFetch([okPayload([["L0001", "t"]])]);
    const seen: number[] = [];
    await translateBatch(cfg, units(["run"]), "español", (p) => seen.push(p.done));
    expect(seen).toEqual([1]);
  });
});

describe("translateSentence", () => {
  it("devuelve la traducción sin comillas", async () => {
    queueFetch([JSON.stringify({ translation: "  Ella corre cada mañana.  " })]);
    expect(await translateSentence(cfg, "She runs every morning.", "español")).toBe(
      "Ella corre cada mañana.",
    );
  });

  it("devuelve cadena vacía si el modelo no traduce", async () => {
    queueFetch([JSON.stringify({})]);
    expect(await translateSentence(cfg, "x", "español")).toBe("");
  });
});
