import { callJson, type LlmConfig } from "./llm";

/**
 * Traducción masiva con las protecciones que hacen falta en producción:
 *
 *  - Lote de ~500 palabras, salida ≤8k tokens (objetivo autoimpuesto, no cap).
 *  - Entradas numeradas `[L001]`: convierte "¿los tengo todos?" — un problema
 *    de memoria — en 500 decisiones independientes.
 *  - Campo `total` DESPUÉS del array: si el modelo se perdió la cuenta, el
 *    array y el número no coinciden.
 *  - Reconciliación por conjunto: faltantes → reintentar sólo esos;
 *    palabras que no enviaste → descartar.
 *  - Halving recursivo ante JSON inválido.
 *
 * `temperature: 0` desde callJson: subir temperatura troca palabras omitidas
 * por inventadas.
 */

export interface TranslationUnit {
  id: string;
  word: string;
  kind: "word" | "phrase";
}

const BATCH = 500;

const SYSTEM = (target: string) =>
  `Eres un lexicógrafo de ${target} para estudiantes de inglés.
Para cada palabra se te da un id entre corchetes y el término. Devuelve las 3 traducciones más
comunes y útiles en ${target}, de más frecuente a menos. Para marcadores (phrasal verbs,
expresiones), traduce el sentido, no palabra por palabra. Mantén el término en inglés en la
primera traducción cuando la forma lo requiera.

Responde EXCLUSIVAMENTE con JSON válido:
{"items":[{"id":"L001","translations":["...","...","..."]}],"total":N}
Incluye exactamente un item por id recibido, sin omitir, sin añadir y sin repetir. "total" es el
número de items del array.`;

async function translateChunk(
  cfg: LlmConfig,
  units: TranslationUnit[],
  targetLang: string,
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const listing = units.map((u) => `[${u.id}] ${u.word}`).join("\n");
  const { json } = await callJson<{
    items?: { id: string; translations?: unknown }[];
    total?: number;
  }>(cfg, {
    system: SYSTEM(targetLang),
    user: listing,
    json: true,
    // 20 tokens/entrada estimado + margen, clampado al objetivo de 8k.
    maxTokens: Math.min(8192, units.length * 20 + 512),
    signal,
  });

  const items = json.items;
  if (!Array.isArray(items)) throw new Error("La respuesta no trae un array `items`");

  const byId = new Map(units.map((u) => [u.id, u]));
  const got = new Map<string, string[]>();
  let invalid = 0;

  for (const it of items) {
    const unit = byId.get(it.id);
    if (!unit) continue; // palabra inventada: descartar
    if (!Array.isArray(it.translations)) {
      invalid++;
      continue;
    }
    // Sólo strings. Un modelo puede devolver null o un número dentro del array
    // y `String(t)` los convertiría en las cadenas "null" y "42", que se
    // mostrarían como traducciones legítimas en la card.
    const translations = it.translations
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (translations.length) got.set(it.id, translations);
  }

  // declared != real: el modelo se perdió la cuenta o truncó.
  if (typeof json.total === "number" && json.total !== items.length) invalid++;

  const missing = units.filter((u) => !got.has(u.id));
  // Los que faltaron se reintentan solos; si no hay nada que reintentar, falla
  // para que el llamador aplique halving sobre el lote entero.
  if (invalid > 0 && missing.length === units.length && units.length > 1) {
    throw new Error(`Lote inconsistente: ${invalid} entradas inválidas de ${units.length}`);
  }
  if (missing.length > 0) {
    const retry = await translateChunk(cfg, missing, targetLang, signal);
    for (const [k, v] of retry) got.set(k, v);
  }

  return got;
}

async function withHalving(
  cfg: LlmConfig,
  units: TranslationUnit[],
  targetLang: string,
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  try {
    return await translateChunk(cfg, units, targetLang, signal);
  } catch (err) {
    if (units.length <= 1) throw err;
    const mid = Math.ceil(units.length / 2);
    const head = await withHalving(cfg, units.slice(0, mid), targetLang, signal);
    const tail = await withHalving(cfg, units.slice(mid), targetLang, signal);
    return new Map([...head, ...tail]);
  }
}

export interface TranslateProgress {
  done: number;
  total: number;
  words: number;
}

export async function translateBatch(
  cfg: LlmConfig,
  units: TranslationUnit[],
  targetLang: string,
  onProgress?: (p: TranslateProgress) => void,
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (let i = 0; i < units.length; i += BATCH) {
    const chunk = units.slice(i, i + BATCH);
    const got = await withHalving(cfg, chunk, targetLang, signal);
    for (const [k, v] of got) result.set(k, v);
    onProgress?.({
      done: Math.min(i + BATCH, units.length),
      total: units.length,
      words: result.size,
    });
  }
  return result;
}

/** Traducción de una frase aislada, cacheada por el llamador. */
export async function translateSentence(
  cfg: LlmConfig,
  sentence: string,
  targetLang: string,
  signal?: AbortSignal,
): Promise<string> {
  const { json } = await callJson<{ translation?: string }>(cfg, {
    system: `Traduce al ${targetLang}. Responde sólo con JSON: {"translation":"..."}`,
    user: sentence,
    json: true,
    maxTokens: 1024,
    signal,
  });
  return (json.translation ?? "").trim();
}
