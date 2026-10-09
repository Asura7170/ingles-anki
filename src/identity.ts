import nlp from "compromise";
import type { Kind } from "./db";

/**
 * Motor de identidad. Reduce una forma flexionada a su lemma.
 *
 * compromise (verificado ejecutando 60 tokens reales) resuelve:
 *   ran→run, went→go, studies→study, swimming→swim,
 *   children→child, geese→goose, knives→knife, mice→mouse, teeth→tooth
 *
 * NO cubre comparativos/superlativos: 0 de 22. Ningún paquete JS lo cubre.
 * NO existe `.lemmatize()` en compromise v14 pese a la documentación.
 */
const COMPARATIVES: Record<string, string> = {
  better: "good",
  best: "good",
  worse: "bad",
  worst: "bad",
  farther: "far",
  farthest: "far",
  further: "far",
  furthest: "far",
  elder: "old",
  eldest: "old",
  later: "late",
  latest: "late",
  latter: "late",
  nearer: "near",
  nearest: "near",
  rounder: "round",
  roundest: "round",
};

/**
 * Falsos amigos del filtro: compromise resuelve el sentido equivocado.
 * `leaves` → `leave` (verbo) cuando en transcripción suele ser plural de *leaf*.
 * Dos palabras distintas colapsan en un nodo → contaminación permanente.
 */
const OVERRIDES: Record<string, string> = {
  leaves: "leaf",
  axes: "axis",
  analyses: "analysis",
};

/** Muletillas y frases vacías. `like` se conserva cuando es léxico (ver isFiller). */
export const FILLERS = new Set([
  "um",
  "uh",
  "er",
  "ah",
  "oh",
  "hmm",
  "mm",
  "mhm",
  "uhh",
  "umm",
  "yeah",
  "yep",
  "yup",
  "nope",
  "okay",
  "ok",
  "wow",
  "hey",
  "hi",
  "well",
  "right",
  "so",
  "now",
  "just",
  "really",
  "actually",
  "basically",
  "literally",
  "obviously",
  "definitely",
  "probably",
  "kind",
  "sort",
  "mean",
  "know",
  "think",
  "gonna",
  "wanna",
  "gotta",
  "lemme",
  "gimme",
  "dunno",
]);

/** spacy/lang/en/stop_words.py, recortado a lo que filtra una transcripción. */
export const STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "cannot",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "s",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "t",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "am",
  "im",
  "ive",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "wont",
  "cant",
  "couldnt",
  "shouldnt",
  "wouldnt",
  "thats",
  "whats",
  "hes",
  "shes",
  "theyre",
  "weve",
  "youve",
  "id",
  "ill",
  "im",
  "u",
  "ur",
  "th",
  "oh",
  "hmm",
  "ah",
  "eh",
  "huh",
]);

const clean = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")
    .replace(/[‐-―]/g, "-");

/** `like` es muletilla salvo cuando lleva objeto directo (I like it). Heurística barata. */
export function isFiller(raw: string): boolean {
  const w = clean(raw);
  if (FILLERS.has(w)) return true;
  if (STOPWORDS.has(w)) return true;
  if (w === "like" || w === "so" || w === "well" || w === "right") {
    return !/\S+\s+(like|so|well|right)\s+\S+/.test(raw);
  }
  return false;
}

export interface Identity {
  lemma: string;
  kind: Kind;
}

/** Lemma de un token suelto o de una frase corta. Devuelve `null` si no es vocabulario. */
export function identify(raw: string): Identity | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  // Frase: 2+ palabras. No se lematiza (give up ≠ gave up).
  if (/^[\p{L}][\p{L}' -]*\s+[\p{L}][\p{L}' -]*$/u.test(text)) {
    const phrase = text.replace(/\s+/g, " ");
    if (phrase.split(" ").every((w) => isFiller(w))) return null;
    return { lemma: phrase, kind: "phrase" };
  }

  const w = clean(raw);
  if (!w || w.length < 2) return null;
  if (isFiller(w)) return null;

  if (OVERRIDES[w]) return { lemma: OVERRIDES[w]!, kind: "word" };
  if (COMPARATIVES[w]) return { lemma: COMPARATIVES[w]!, kind: "word" };

  const doc = nlp(w);
  if (doc.verbs().found) {
    const inf = doc.verbs().toInfinitive().text().trim();
    if (inf) return { lemma: inf, kind: "word" };
  }
  if (doc.nouns().found) {
    const sing = doc.nouns().toSingular().text().trim();
    if (sing) return { lemma: sing, kind: "word" };
  }
  return { lemma: w, kind: "word" };
}

/**
 * En un .apkg todo es vocabulario por decisión del usuario: los filtros de
 * transcripciones no pueden saltar notas (have/like/think/know/ill… son
 * palabras del mazo, no muletillas). Si `identify` dice null y queda texto
 * con ≥2 letras, entra como identidad literal. `skipped` queda para lo que
 * ni es texto.
 */
export function fallbackIdentity(raw: string): Identity | null {
  // Mismos bordes que `clean`: "Have!" es "have", no un lemma aparte que
  // ningún matching vuelve a encontrar (nodo duplicado e inigualable).
  const text = clean(raw).replace(/\s+/g, " ");
  if (text.replace(/[^\p{L}]/gu, "").length < 2) return null;
  return { lemma: text, kind: text.includes(" ") ? "phrase" : "word" };
}

/**
 * Un solo resolutor de lemma para el mundo .apkg: `identify` primero y
 * `fallbackIdentity` después. Cuatro caminos (`mentionsHeadword`,
 * `mapFields`, `isNoiseTranslation`, `blankSentence`) usaban `identify` a
 * secas y dejaban sordos a los stopwords que el import sí habilita ("like"
 * perdía su ejemplo y su cloze). `extractCandidates` NO lo usa: en texto
 * saltar stopwords sigue siendo la intención.
 */
export const lemmaOf = (raw: string): string | undefined =>
  (identify(raw) ?? fallbackIdentity(raw))?.lemma;

/**
 * Etiquetas gramaticales de diccionario. Set cerrado y minúsculas: un campo
 * que ES la etiqueta no es traducción. Con punto opcional ("n.").
 */
const POS_TAGS = new Set([
  "noun",
  "verb",
  "adjective",
  "adverb",
  "pronoun",
  "preposition",
  "conjunction",
  "interjection",
  "determiner",
  "article",
  "numeral",
  "n",
  "v",
  "adj",
  "adv",
  "prep",
  "conj",
  "pron",
  "interj",
  "det",
  "art",
  "num",
]);

/** Esqueleto consonántico: minúsculas, sin diacríticos ni vocales, con
 * equivalencias fonéticas (th→t, c/s→k). "krái"→"kr", "cry"→"kr". */
function skeleton(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/θ/g, "t")
    .replace(/ð/g, "t")
    .replace(/ŋ/g, "n")
    .replace(/ʃ/g, "s")
    .replace(/ʒ/g, "z")
    .replace(/th/g, "t")
    .replace(/sh/g, "s")
    .replace(/ph/g, "f")
    .replace(/ch/g, "t") // watch→wtt, wɑ́tʃ→wtt (la ch de respelling es /tʃ/)
    .replace(/[^a-z]/g, "")
    .replace(/[aeiouy]/g, "")
    .replace(/c/g, "k")
    .replace(/s/g, "k");
}

/** Distancia de edición para esqueletos cortos (geminadas: fn/fnn). */
function lev(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * ¿Este campo es ruido de diccionario y no traducción? Tres clases:
 * etiqueta POS ("verb"), forma de la palabra ("cries"→cry) y pronunciación
 * ("krái": mismo esqueleto que el headword + no-ASCII).
 *
 * Solo cae ASCII si es POS exacto o forma: una traducción normal ("correr",
 * "animal") nunca coincide. Tradeoff documentado: un cognado acentuado
 * ("música"→msk como "music") sí cae; solo vuelve vía LLM si el sentido queda
 * vacío (`collectMissing` salta sentidos con algo), y un re-import con el
 * sentido tocado por la IA no lo poda (ver `attachTranslations`).
 */
export function isNoiseTranslation(field: string, headword: string): boolean {
  const t = field.trim();
  if (!t || /\s/.test(t)) return false;
  if (POS_TAGS.has(t.toLowerCase().replace(/\.$/, ""))) return true;
  const lemma = lemmaOf(headword);
  if (!lemma) return false;
  if (lemmaOf(t) === lemma) return true;
  if (!/[^\x00-\x7F]/.test(t)) return false;
  const a = skeleton(t);
  const b = skeleton(headword);
  return a.length > 0 && b.length > 0 && a.length <= 12 && b.length <= 12 && lev(a, b) <= 1;
}

/**
 * Extrae candidatos de un texto: tokeniza, lematiza, cuenta ocurrencias y
 * conserva la frase más corta que contiene cada palabra.
 */
export interface Candidate {
  lemma: string;
  kind: Kind;
  headword: string;
  occurrences: number;
  bestSentence: string | undefined;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

export function extractCandidates(text: string): Candidate[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);

  const acc = new Map<string, Candidate>();

  for (const sentence of sentences) {
    for (const raw of sentence.split(/\s+/)) {
      const id = identify(raw);
      if (!id) continue;

      const existing = acc.get(id.lemma);
      if (!existing) {
        acc.set(id.lemma, {
          lemma: id.lemma,
          kind: id.kind,
          headword: clean(raw),
          occurrences: 1,
          bestSentence: sentence,
        });
        continue;
      }
      existing.occurrences++;
      // La más corta gana: menos vocabulario ajeno = mejor ancla mnemotécnica.
      if (sentence.split(/\s+/).length < existing.bestSentence!.split(/\s+/).length) {
        existing.bestSentence = sentence;
      }
    }
  }

  return [...acc.values()];
}

/**
 * Localiza la palabra dentro de la frase y devuelve las dos mitades para poder
 * dibujar el hueco, MÁS el token original: la respuesta esperada es la forma
 * de la frase ("cries"), no el lemma ("cry"). Usa `lemmaOf` para que la
 * flexión coincida (`running` con lemma `run`) y los stopwords del .apkg
 * también tengan hueco.
 *
 * `word` es el núcleo sin puntuación de bordes ("apples", no "apples."): el
 * delimitador no es forma de la frase y calificar contra "apples." marcaba
 * "Difícil" una respuesta correcta. Los bordes se quedan en `before`/`after`
 * para que la frase pintada no pierda el punto.
 */
export function blankSentence(
  sentence: string,
  node: { lemma: string },
): { before: string; word: string; after: string } | null {
  const tokens = sentence.split(/(\s+)/);
  for (let i = 0; i < tokens.length; i++) {
    if (lemmaOf(tokens[i]!) !== node.lemma) continue;
    const tok = tokens[i]!;
    const lead = /^\P{L}*/u.exec(tok)![0];
    const tail = /\P{L}*$/u.exec(tok)![0];
    const word = tok.slice(lead.length, tok.length - tail.length);
    if (!word) continue;
    return {
      before: tokens.slice(0, i).join("") + lead,
      word,
      after: tail + tokens.slice(i + 1).join(""),
    };
  }
  return null;
}

/**
 * Lo que la card espera: la palabra tal como aparece en la frase, o el lemma
 * si no hay frase (o no hay hueco). Fuente única para calificar (store) y
 * mostrar (Study): dos cálculos acabarian divergiendo.
 */
export function expectedWord(node: { lemma: string }, sentence?: string): string {
  if (!sentence) return node.lemma;
  return blankSentence(sentence, node)?.word ?? node.lemma;
}

/**
 * Frecuencia de corpus. Se carga desde /frequency.json si existe (NGSL 1.2 +
 * FrequencyWords en_50k). Sin el archivo, el filtro degrada a stopwords + known.
 */
let freqCache: Map<string, number> | null = null;
let ngslCache: Set<string> | null = null;

/**
 * Caché por URL: `loadFrequency` es idempotente pero la UI la llama desde varios
 * sitios y en modo StrictMode React la invoca dos veces. Sin esto, dos fetch en
 * paralelo del mismo archivo.
 */
const pending = new Map<string, Promise<void>>();

export async function loadFrequency(): Promise<Map<string, number>> {
  if (freqCache) return freqCache;
  freqCache = new Map();
  ngslCache = new Set();

  const url = "/frequency.json";
  let task = pending.get(url);
  if (!task) {
    task = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const raw = (await res.json()) as { rank?: Record<string, number>; ngsl?: string[] };
        for (const [w, r] of Object.entries(raw.rank ?? {})) freqCache!.set(w, r);
        for (const w of raw.ngsl ?? []) ngslCache!.add(w);
      } catch {
        // Degradación silenciosa: sin datos de frecuencia el filtro se apoya
        // sólo en stopwords y en `known`.
      }
    })();
    pending.set(url, task);
  }
  await task;

  return freqCache;
}

export function freqRank(lemma: string): number | undefined {
  return freqCache?.get(lemma);
}

export function isNGSL(lemma: string): boolean {
  return ngslCache?.has(lemma) ?? false;
}

/** Sólo para tests: fuerza la recarga del archivo de frecuencia. */
export function __resetFrequencyCache(): void {
  freqCache = null;
  ngslCache = null;
  pending.clear();
}
