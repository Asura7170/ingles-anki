import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { freqRank, isNGSL, loadFrequency, __resetFrequencyCache } from "./identity";

/**
 * Los datos de frecuencia son opcionales: NGSL 1.2 + FrequencyWords en_50k son
 * CC-BY-SA y no se empaquetan. Si el archivo falta, el filtro debe degradar a
 * stopwords + `known` en lugar de romperse.
 */

beforeEach(() => __resetFrequencyCache());
afterEach(() => vi.restoreAllMocks());

const payload = (rank: Record<string, number>, ngsl: string[]) => ({ rank, ngsl });

describe("loadFrequency — sin el archivo", () => {
  it("degrada en silencio si fetch falla", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("404")));
    await expect(loadFrequency()).resolves.toBeInstanceOf(Map);
  });

  it("degrada si la respuesta no es ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(loadFrequency()).resolves.toBeInstanceOf(Map);
  });

  it("degrada si el JSON está malformado", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no json")));
    await expect(loadFrequency()).resolves.toBeInstanceOf(Map);
  });

  it("tolera un payload sin las claves esperadas", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({}))));
    await expect(loadFrequency()).resolves.toBeInstanceOf(Map);
  });
});

describe("loadFrequency — con el archivo", () => {
  it("carga rangos y NGSL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload({ run: 120, comm: 4000 }, ["the", "run"])), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await loadFrequency();
    expect(freqRank("run")).toBe(120);
    expect(freqRank("comm")).toBe(4000);
    expect(isNGSL("the")).toBe(true);
    expect(isNGSL("comm")).toBe(false);
  });

  it("devuelve undefined para una palabra ausente", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(payload({ run: 1 }, [])))),
    );
    await loadFrequency();
    expect(freqRank("zzzz")).toBeUndefined();
  });

  it("no refetch en la segunda llamada", async () => {
    const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload({ run: 1 }, []))));
    vi.stubGlobal("fetch", fn);

    await loadFrequency();
    await loadFrequency();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("llamadas concurrentes comparten una sola petición", async () => {
    // React StrictMode monta dos veces en dev: sin este caché son dos fetch.
    const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload({ run: 1 }, []))));
    vi.stubGlobal("fetch", fn);

    await Promise.all([loadFrequency(), loadFrequency(), loadFrequency()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("freqRank / isNGSL antes de cargar", () => {
  it("no lanza con la caché vacía", () => {
    expect(freqRank("run")).toBeUndefined();
    expect(isNGSL("the")).toBe(false);
  });
});

describe("identificación sin datos de frecuencia", () => {
  it("el motor sigue funcionando: la frecuencia sólo ordena, no decide", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await loadFrequency();
    const { identify } = await import("./identity");
    expect(identify("running")?.lemma).toBe("run");
  });
});
