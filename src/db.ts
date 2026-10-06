import Dexie, { type Table } from "dexie";
import type { Card } from "ts-fsrs";

export type { Card };

export type Kind = "word" | "phrase";
export type SourceKind = "apkg" | "text" | "pdf" | "ai" | "manual";
export type Ease = 1 | 2 | 3 | 4;
export type RelationType = "collocation" | "opposite" | "similarTo" | "partOf";

/** La identidad. El SRS vive aquí y es global: no depende del deck. */
export interface Node {
  id?: number;
  headword: string;
  /** Clave única. kind:'phrase' → el lemma es la frase entera. */
  lemma: string;
  kind: Kind;
  nSenses?: number;
  freqRank?: number;
  ngsl?: boolean;
  /** Hecho sobre ti, separado del SRS. */
  known: 0 | 1;
  card: Card | null;
  /** Espejo de card.due en ms, sólo para poder indexar. */
  due: number;
  createdAt: number;
  updatedAt: number;
}

/** Hijo de un nodo. Cada sense tiene su propio historial FSRS. */
export interface Sense {
  id?: number;
  nodeId: number;
  synsetId?: string;
  gloss?: string;
  translations: string[];
  translationSource: SourceKind | null;
  sentenceTranslation?: string;
  card: Card | null;
  due: number;
}

/** Una fila por (nodo, origen). Nunca pisa; la prioridad decide cuál gana. */
export interface Source {
  id?: number;
  nodeId: number;
  kind: SourceKind;
  deckId?: number;
  noteId?: number;
  level?: string;
  sourceTextId?: number;
  occurrenceCount?: number;
  priority: number;
  /** Hash del contenido: detecta cambios al reimportar. */
  contentVersion: string;
  addedAt: number;
}

/** Múltiples por nodo. La más corta gana como contexto de la card. */
export interface Example {
  id?: number;
  nodeId: number;
  text: string;
  translation?: string;
  sourceId?: number | null;
}

export interface Relation {
  id?: number;
  fromNodeId: number;
  toWord: string;
  type: RelationType;
  sourceId?: number | null;
}

export interface ReviewLog {
  id?: number;
  nodeId: number;
  ts: number;
  ease: Ease;
  /** Permite atribuir progreso a un deck aunque el SRS sea global. */
  deckId?: number;
  typed?: string;
  ok?: number;
  bad?: number;
  missing?: number;
  source: "button" | "typing" | "import";
}

/** Exposición pasiva. NUNCA se inyecta al scheduler. */
export interface Exposure {
  id?: number;
  nodeId: number;
  sourceTextId?: number;
  ts: number;
  occurrences: number;
  outcome?: "unknown";
}

export interface SourceText {
  id?: number;
  kind: "text" | "pdf" | "srt";
  title: string;
  body: string;
  importedAt: number;
}

/** Un deck es una query sobre el pool de nodos. No contiene cards. */
export interface Deck {
  id?: number;
  name: string;
  kind: "import" | "generated" | "filter";
  levels?: string[];
  sourceTextIds?: number[];
  wordKinds?: Kind[];
  dailyNewLimit?: number;
  createdAt: number;
}

export interface Settings {
  key: string;
  value: unknown;
}

export const TABLES = [
  "nodes",
  "senses",
  "sources",
  "examples",
  "relations",
  "reviewLog",
  "exposure",
  "sourceTexts",
  "decks",
] as const;

class VocabDB extends Dexie {
  nodes!: Table<Node, number>;
  senses!: Table<Sense, number>;
  sources!: Table<Source, number>;
  examples!: Table<Example, number>;
  relations!: Table<Relation, number>;
  reviewLog!: Table<ReviewLog, number>;
  exposure!: Table<Exposure, number>;
  sourceTexts!: Table<SourceText, number>;
  decks!: Table<Deck, number>;
  settings!: Table<Settings, string>;

  constructor() {
    super("vocab");
    this.version(1).stores({
      nodes: "++id, &lemma, kind, known, due, freqRank",
      senses: "++id, nodeId, due",
      sources: "++id, nodeId, deckId, noteId, sourceTextId",
      examples: "++id, nodeId",
      relations: "++id, fromNodeId, toWord",
      reviewLog: "++id, nodeId, ts",
      exposure: "++id, nodeId, ts",
      sourceTexts: "++id, importedAt",
      decks: "++id, name, kind",
      settings: "key",
    });
  }
}

export const db = new VocabDB();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
