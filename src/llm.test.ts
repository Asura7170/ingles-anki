import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { callJson, streamChat, type LlmConfig } from "./llm";

/**
 * Cliente OpenAI-compatible propio (fetch + parser SSE). Los tres casos que
 * importan están documentados en `translate.ts`; aquí se verifica el transporte.
 */

const cfg: LlmConfig = { baseUrl: "http://localhost:1234/v1", apiKey: "", model: "test-model" };

afterEach(() => vi.restoreAllMocks());

function mockFetch(body: unknown, init: { status?: number } = {}) {
  const fn = vi.fn().mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("callJson", () => {
  it("envía el prompt y devuelve el JSON parseado", async () => {
    const fn = mockFetch({ choices: [{ message: { content: '{"total":2}' } }] });
    const { json } = await callJson<{ total: number }>(cfg, { user: "x", json: true });

    expect(json.total).toBe(2);
    const body = JSON.parse(fn.mock.calls[0]![1].body as string);
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("normaliza la barra final y adjunta la API key", async () => {
    const fn = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await callJson({ ...cfg, baseUrl: "http://x/v1/", apiKey: "k" }, { user: "x" });

    expect(fn.mock.calls[0]![0]).toBe("http://x/v1/chat/completions");
    expect((fn.mock.calls[0]![1].headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("omite la autorización si no hay key (endpoint local)", async () => {
    const fn = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await callJson(cfg, { user: "x" });

    expect((fn.mock.calls[0]![1].headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("manda max_tokens estimado, nunca el máximo del modelo", async () => {
    // OpenRouter reserva collateral por max_tokens y devuelve 402 si es el tope.
    const fn = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await callJson(cfg, { user: "x", maxTokens: 8192 });

    const body = JSON.parse(fn.mock.calls[0]![1].body as string);
    expect(body.max_tokens).toBe(8192);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("usa max_completion_tokens en modelos de razonamiento", async () => {
    const fn = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await callJson({ ...cfg, model: "gpt-5-mini" }, { user: "x", maxTokens: 4096 });

    const body = JSON.parse(fn.mock.calls[0]![1].body as string);
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
  });

  it("reintenta con el otro nombre de parámetro ante un 400", async () => {
    // Ollama ignora max_completion_tokens en silencio; Gemini-compatible
    // rechaza ambos a la vez. Un solo reintento con el nombre contrario.
    const fn = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unsupported parameter: max_tokens", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fn);

    const { json } = await callJson<{ ok: boolean }>(cfg, { user: "x" });
    expect(json.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propaga un 400 que no habla de tokens", async () => {
    mockFetch("model not found", { status: 400 });
    await expect(callJson(cfg, { user: "x" })).rejects.toThrow(/model not found/);
  });

  it("propaga otros errores con el status", async () => {
    mockFetch("rate limited", { status: 429 });
    await expect(callJson(cfg, { user: "x" })).rejects.toThrow(/HTTP 429/);
  });

  it("expone usage.completion_tokens para detectar truncamiento", async () => {
    mockFetch({
      choices: [{ message: { content: "{}" }, finish_reason: "length" }],
      usage: { completion_tokens: 8192 },
    });
    const r = await callJson(cfg, { user: "x", maxTokens: 8192 });
    expect(r.completionTokens).toBe(8192);
    expect(r.finishReason).toBe("length");
  });
});

describe("streamChat", () => {
  const sse = (...chunks: string[]) =>
    new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          for (const ch of chunks) c.enqueue(enc.encode(ch));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

  it("concatena el texto de los deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sse(
            'data: {"choices":[{"delta":{"content":"Hola"}}]}\n',
            'data: {"choices":[{"delta":{"content":", mun"}}]}\n',
            "data: [DONE]\n",
          ),
        ),
    );

    const chunks: string[] = [];
    const r = await streamChat(cfg, {
      messages: [{ role: "user", content: "x" }],
      onText: (t) => chunks.push(t),
    });

    expect(r.text).toBe("Hola, mun");
    expect(chunks).toEqual(["Hola", ", mun"]);
    expect(r.toolCalls).toEqual([]);
  });

  it("acumula los argumentos de un tool call partido en varios deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sse(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"run\\"}"}}]}}]}\n',
            "data: [DONE]\n",
          ),
        ),
    );

    const r = await streamChat(cfg, {
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "search", description: "", parameters: {} } }],
    });

    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]!.name).toBe("search");
    expect(r.toolCalls[0]!.args).toEqual({ q: "run" });
  });

  it("ignora deltas que no son JSON válido", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sse(
            "data: : comentario keep-alive\n",
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
            "data: [DONE]\n",
          ),
        ),
    );
    const r = await streamChat(cfg, { messages: [{ role: "user", content: "x" }] });
    expect(r.text).toBe("ok");
  });

  it("tolera argumentos vacíos o malformados", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sse(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"t","arguments":"NO_JSON"}}]}}]}\n',
          ),
        ),
    );
    const r = await streamChat(cfg, {
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "t", description: "", parameters: {} } }],
    });
    expect(r.toolCalls[0]!.args).toEqual({});
  });

  it("no manda temperature a un stream con tools", async () => {
    const fn = vi.fn().mockResolvedValue(sse("data: [DONE]\n"));
    vi.stubGlobal("fetch", fn);
    await streamChat(cfg, {
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "t", description: "", parameters: {} } }],
    });
    expect(JSON.parse(fn.mock.calls[0]![1].body as string).tool_choice).toBe("auto");
  });
});
