/**
 * Cliente OpenAI-compatible mínimo: `fetch` + parser SSE. No usamos el SDK `ai`
 * de Vercel (115 KB, framework de servidor, 8 releases en 12 meses) ni el SDK
 * `openai` (que lanza en el navegador salvo dangerouslyAllowBrowser).
 *
 * CORS no tiene arreglo del lado cliente: el endpoint configurado debe servirlo.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

/** Modelos de razonamiento exigen max_completion_tokens y rechazan max_tokens. */
const needsMaxCompletion = (model: string) => /^(gpt-5|o[134])|reasoning/i.test(model);

const url = (base: string) => `${base.replace(/\/+$/, "")}/chat/completions`;

function headers(cfg: LlmConfig): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

interface PostOpts {
  system?: string;
  user?: string;
  json?: boolean;
  tools?: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
}

async function post(
  cfg: LlmConfig,
  opts: PostOpts,
  useMaxCompletion: boolean,
  stream: boolean,
): Promise<Response> {
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  if (opts.user) messages.push({ role: "user", content: opts.user });

  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: 0,
    stream,
  };
  if (opts.tools?.length) {
    payload.tools = opts.tools;
    payload.tool_choice = "auto";
  }
  if (!stream) {
    if (opts.json) payload.response_format = { type: "json_object" };
    // Mandar SIEMPRE el valor estimado, nunca el máximo del modelo: OpenRouter
    // reserva ese collateral y devuelve HTTP 402.
    const budget = opts.maxTokens ?? 4096;
    payload[useMaxCompletion ? "max_completion_tokens" : "max_tokens"] = budget;
  }

  return fetch(url(cfg.baseUrl), {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
}

async function fail(res: Response): Promise<never> {
  throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
}

/** Llamada sin streaming. Reintenta una vez con el otro nombre de parámetro. */
export async function callJson<T>(
  cfg: LlmConfig,
  opts: PostOpts,
): Promise<{ json: T; completionTokens?: number; finishReason?: string }> {
  let useMc = needsMaxCompletion(cfg.model);
  let res = await post(cfg, opts, useMc, false);

  if (res.status === 400) {
    const text = await res.text();
    // Ollama ignora max_completion_tokens en silencio; Gemini-compatible
    // rechaza ambos a la vez. Un solo reintento con el nombre contrario.
    if (/max_tokens|max_completion_tokens/i.test(text)) {
      res = await post(cfg, opts, !useMc, false);
    } else {
      throw new Error(`HTTP 400: ${text.slice(0, 400)}`);
    }
  }
  if (!res.ok) await fail(res);

  const data = (await res.json()) as {
    choices: { message: { content: string | null }; finish_reason?: string }[];
    usage?: { completion_tokens?: number };
  };
  const choice = data.choices[0];
  const raw = choice?.message.content ?? "";

  return {
    json: JSON.parse(raw) as T,
    completionTokens: data.usage?.completion_tokens,
    finishReason: choice?.finish_reason,
  };
}

async function* sse(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield data;
    }
  }
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
}

/** Trozo de tool call tal como llega en un delta del stream. */
interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface Chunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
}

type PartialToolCall = { id: string; name: string; args: string };

/**
 * El sobre de un delta trae seis niveles de optional chaining. Normalizarlo una
 * sola vez aquí deja el bucle del stream sin una cadena de `?.` por línea, que
 * además cada `?.` cuenta como decisión de complejidad.
 */
function firstDelta(chunk: Chunk): { content: string; tools: ToolCallDelta[] } {
  const delta = chunk.choices?.[0]?.delta;
  return { content: delta?.content ?? "", tools: delta?.tool_calls ?? [] };
}

/**
 * El stream trocea cada tool call: un delta trae el id, otro el nombre, otro un
 * fragmento de argumentos. Se concatenan por índice. El `name` se acumula y no
 * se sobrescribe porque hay proveedores que lo repiten en cada delta.
 */
function accumulateToolCall(partial: Map<number, PartialToolCall>, tc: ToolCallDelta): void {
  const idx = tc.index ?? 0;
  const entry = partial.get(idx) ?? { id: "", name: "", args: "" };
  if (tc.id) entry.id = tc.id;
  if (tc.function?.name) entry.name += tc.function.name;
  if (tc.function?.arguments) entry.args += tc.function.arguments;
  partial.set(idx, entry);
}

/**
 * Los argumentos llegan como texto JSON concatenado y pueden venir truncados si
 * el stream se corta. Degradar a `{}` es correcto: el validador de tool calls
 * rechaza la llamada, mientras que lanzar aquí tiraría la respuesta completa.
 */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function buildPayload(
  cfg: LlmConfig,
  opts: { messages: ChatMessage[]; tools?: ToolDef[] },
  stream: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages: opts.messages,
    temperature: 0,
    stream,
  };
  // `tool_choice` solo tiene sentido junto a `tools`: enviarlo sin lista hace
  // fallar el 400 en varios proveedores.
  if (opts.tools?.length) {
    payload.tools = opts.tools;
    payload.tool_choice = "auto";
  }
  return payload;
}

export async function streamChat(
  cfg: LlmConfig,
  opts: {
    messages: ChatMessage[];
    tools?: ToolDef[];
    signal?: AbortSignal;
    onText?: (t: string) => void;
  },
): Promise<StreamResult> {
  const res = await fetch(url(cfg.baseUrl), {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(buildPayload(cfg, opts, true)),
    signal: opts.signal,
  });
  if (!res.ok) await fail(res);

  let text = "";
  const partial = new Map<number, PartialToolCall>();

  for await (const data of sse(res)) {
    let chunk: Chunk;
    try {
      chunk = JSON.parse(data) as Chunk;
    } catch {
      // Un SSE mal formado no debe tumbar el resto del stream.
      continue;
    }
    const { content, tools } = firstDelta(chunk);
    if (content) {
      text += content;
      opts.onText?.(content);
    }
    for (const tc of tools) accumulateToolCall(partial, tc);
  }

  const toolCalls: ToolCall[] = [...partial.values()]
    .filter((p) => p.name)
    .map((p) => ({ id: p.id || `call_${p.name}`, name: p.name, args: parseArgs(p.args) }));

  return { text, toolCalls };
}
