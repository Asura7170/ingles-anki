import { create } from "zustand";
import { db, getSetting, setSetting, type Deck, type Ease } from "./db";
import { scheduleAutoSave } from "./backup";
import { loadFrequency } from "./identity";
import { newCard, review as srsReview } from "./srs";
import { gradeTyping, hasTypingContext } from "./grade";
import { buildQueue, type StudyItem } from "./decks";
import type { Comparison } from "./diff";

export type View = "decks" | "ingest" | "words" | "settings";

export interface Prefs {
  targetLang: string;
  ttsLang: string;
  ttsRate: number;
  threshold: number;
  dailyNewLimit: number;
  typingRequired: boolean;
  llm: { baseUrl: string; apiKey: string; model: string };
}

export const DEFAULT_PREFS: Prefs = {
  targetLang: "español",
  ttsLang: "en-US",
  ttsRate: 0.95,
  threshold: 0.8,
  dailyNewLimit: 20,
  typingRequired: true,
  llm: { baseUrl: "http://localhost:1234/v1", apiKey: "", model: "" },
};

interface AppState {
  view: View;
  prefs: Prefs;
  busy: string | null;
  toast: string | null;

  deck: Deck | null;
  queue: StudyItem[];
  pos: number;
  revealed: boolean;
  typed: string;
  suggested: Ease | null;
  comparison: Comparison | null;
  typingHint: boolean;

  boot: () => Promise<void>;
  setView: (v: View) => void;
  setPrefs: (p: Partial<Prefs>) => Promise<void>;
  notify: (msg: string) => void;
  startSession: (deck: Deck) => Promise<void>;
  setTyped: (t: string) => void;
  reveal: () => void;
  advance: (ease: Ease) => Promise<void>;
  endSession: () => void;
  unmark: (nodeId: number, mode: "reset" | "due-now") => Promise<void>;
}

const inFlight = new Set<string>();

export const useApp = create<AppState>((set, get) => ({
  view: "decks",
  prefs: DEFAULT_PREFS,
  busy: null,
  toast: null,

  deck: null,
  queue: [],
  pos: 0,
  revealed: false,
  typed: "",
  suggested: null,
  comparison: null,
  typingHint: false,

  async boot() {
    await Promise.all([loadFrequency(), navigator.storage?.persist?.()]);
    set({ prefs: await getSetting<Prefs>("prefs", DEFAULT_PREFS) });
  },

  setView(view) {
    set({ view });
  },

  async setPrefs(patch) {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    await setSetting("prefs", prefs);
  },

  notify(msg) {
    set({ toast: msg });
    setTimeout(() => set((s) => (s.toast === msg ? { toast: null } : s)), 4000);
  },

  async startSession(deck) {
    set({ busy: "Preparando sesión…" });
    try {
      const queue = await buildQueue({ ...deck, dailyNewLimit: get().prefs.dailyNewLimit });
      if (!queue.length) {
        get().notify("No hay palabras pendientes en este mazo.");
        return;
      }
      set({
        deck,
        queue,
        pos: 0,
        revealed: false,
        typed: "",
        suggested: null,
        comparison: null,
        typingHint: false,
        view: "words",
      });
      void prefetchTranslations(get().prefs, queue.slice(0, 5));
    } finally {
      set({ busy: null });
    }
  },

  setTyped(typed) {
    set({ typed, typingHint: false });
  },

  reveal() {
    const { queue, pos, typed, prefs, revealed } = get();
    const item = queue[pos];
    if (!item || revealed) return;

    const wrote = typed.trim().length > 0;
    // El typing sólo es obligatorio cuando hay frase: sin contexto no hay
    // recuperación posible y exigirlo es mantenimiento puro.
    if (!wrote && prefs.typingRequired && hasTypingContext(item.sentence)) {
      set({ typingHint: true });
      return;
    }

    const { comparison, suggested } = gradeTyping(item.node.lemma, typed, prefs.threshold);
    set({ revealed: true, comparison, suggested, typingHint: false });
  },

  async advance(ease) {
    const { queue, pos, typed, comparison, deck } = get();
    const item = queue[pos];
    if (!item) return;

    const card = srsReview(item.node.card ?? newCard(), ease);
    await db.transaction("rw", db.nodes, db.reviewLog, async () => {
      await db.nodes.update(item.node.id!, {
        card,
        due: card.due.getTime(),
        updatedAt: Date.now(),
      });
      await db.reviewLog.add({
        nodeId: item.node.id!,
        ts: Date.now(),
        ease,
        deckId: deck?.id,
        typed: typed.trim() || undefined,
        ok: comparison?.ok,
        bad: comparison?.bad,
        missing: comparison?.missing,
        source: typed.trim() ? "typing" : "button",
      });
    });

    scheduleAutoSave();
    const next = pos + 1;
    set({
      revealed: false,
      typed: "",
      suggested: null,
      comparison: null,
      typingHint: false,
      pos: next,
    });

    if (next >= queue.length) {
      set({ queue: [], deck: null, pos: 0 });
      get().notify("Sesión completada.");
    } else {
      void prefetchTranslations(get().prefs, queue.slice(next, next + 5));
    }
  },

  endSession() {
    set({
      queue: [],
      deck: null,
      pos: 0,
      revealed: false,
      typed: "",
      suggested: null,
      comparison: null,
      view: "decks",
    });
  },

  async unmark(nodeId: number, mode: "reset" | "due-now") {
    const node = await db.nodes.get(nodeId);
    if (!node) return;
    if (mode === "reset") {
      await db.nodes.update(nodeId, { known: 0, card: newCard(), due: Date.now() });
      get().notify(`${node.headword}: historial reiniciado.`);
    } else {
      // "la sé pero quiero verla antes": el SRS no cambia, sólo aparece ya.
      await db.nodes.update(nodeId, { known: 0, due: Date.now() });
      get().notify(`${node.headword}: aparecerá de inmediato.`);
    }
    scheduleAutoSave();
  },
}));

/**
 * Prefetch: al abrir sesión y en cada avance se traducen la palabra visible +
 * las 4 siguientes. Nunca se traduce "la que tienes delante" — eso genera lag.
 */
export async function prefetchTranslations(prefs: Prefs, nodes: StudyItem[]): Promise<void> {
  const { llm, targetLang } = prefs;
  if (!llm.model || nodes.length === 0) return;

  const units: { id: string; word: string; kind: "word" | "phrase" }[] = [];
  for (const { node } of nodes) {
    if (inFlight.has(node.lemma)) continue;
    const sense = await db.senses.where("nodeId").equals(node.id!).first();
    if (sense && sense.translations.length > 0) continue;
    inFlight.add(node.lemma);
    units.push({ id: `L${String(node.id).padStart(4, "0")}`, word: node.lemma, kind: node.kind });
  }
  if (!units.length) return;

  try {
    const { translateBatch } = await import("./translate");
    const got = await translateBatch(llm, units, targetLang);
    await db.transaction("rw", db.senses, async () => {
      for (const [id, translations] of got) {
        const nodeId = Number(id.slice(1));
        const sense = await db.senses.where("nodeId").equals(nodeId).first();
        if (!sense) continue;
        const set = new Set(sense.translations);
        const before = set.size;
        for (const t of translations) set.add(t);
        if (set.size !== before) {
          await db.senses.update(sense.id!, { translations: [...set], translationSource: "ai" });
        }
      }
    });
  } catch {
    // Un fallo de prefetch no interrumpe la sesión: la card cae a solo-palabra.
  } finally {
    for (const u of units) inFlight.delete(u.word);
  }
}
