import { useState } from "react";
import { db } from "../db";
import { ingest, hash } from "../ingest";
import { extractCandidates, loadFrequency, freqRank, type Candidate } from "../identity";
import { importApkg } from "../apkg";
import { useApp } from "../store";
import { scheduleAutoSave } from "../backup";

export default function Ingest() {
  const notify = useApp((s) => s.notify);
  const prefs = useApp((s) => s.prefs);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Candidate[]>([]);
  const [stats, setStats] = useState<{ total: number; known: number; fresh: number } | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const analyze = async () => {
    await loadFrequency();
    const candidates = extractCandidates(text);
    const [knownNodes, allNodes] = await Promise.all([
      db.nodes.where("known").equals(1).toArray(),
      db.nodes.toArray(),
    ]);
    const known = new Set(knownNodes.map((n) => n.lemma));
    const existing = new Set(allNodes.map((n) => n.lemma));

    // El filtro: lo que ya declaras conocido + lo demasiado básico.
    // Sin /frequency.json el umbral de frecuencia no aplica.
    const kept = candidates.filter((c) => {
      if (known.has(c.lemma)) return false;
      const rank = freqRank(c.lemma);
      return rank === undefined || rank <= 8000;
    });

    setPreview(kept);
    setStats({
      total: candidates.length,
      known: candidates.length - kept.length,
      fresh: kept.filter((c) => !existing.has(c.lemma)).length,
    });
  };

  const createDeck = async () => {
    if (!preview.length) return;
    setWorking("Creando mazo…");
    try {
      const name = title.trim() || `Texto ${new Date().toLocaleDateString("es")}`;
      const sourceTextId = (await db.sourceTexts.add({
        kind: "text",
        title: name,
        body: text,
        importedAt: Date.now(),
      }))!;

      const result = await ingest(
        preview.map((c) => ({
          headword: c.headword,
          lemma: c.lemma,
          kind: c.kind,
          occurrences: c.occurrences,
          examples: c.bestSentence ? [{ text: c.bestSentence }] : undefined,
        })),
        { kind: "text", priority: 20, sourceTextId },
      );

      // Exposición pasiva: registro aparte. NUNCA se inyecta al scheduler.
      const nodes = await db.nodes.toArray();
      const byLemma = new Map(nodes.map((n) => [n.lemma, n.id!]));
      const rows = preview
        .map((c) => ({ nodeId: byLemma.get(c.lemma), occurrences: c.occurrences }))
        .filter((r): r is { nodeId: number; occurrences: number } => r.nodeId !== undefined)
        .map((r) => ({ ...r, sourceTextId, ts: Date.now() }));
      if (rows.length) await db.exposure.bulkAdd(rows);

      await db.decks.add({
        name,
        kind: "generated",
        sourceTextIds: [sourceTextId],
        createdAt: Date.now(),
      });

      notify(`Mazo «${name}»: ${result.created} nuevas, ${result.merged} ya existían.`);

      // Traducir lo que no tiene traducción. La IA nunca sobrescribe.
      if (prefs.llm.model) {
        setWorking("Traduciendo lo que falta…");
        await translateMissing(prefs, preview, notify);
      } else {
        notify("Sin endpoint LLM: las palabras nuevas saldrán sin traducción.");
      }

      setText("");
      setPreview([]);
      setStats(null);
      scheduleAutoSave();
    } finally {
      setWorking(null);
    }
  };

  const onApkg = async (file: File) => {
    setWorking("Leyendo el .apkg…");
    try {
      const res = await importApkg(file);
      notify(
        `${res.deckName}: ${res.result.created} nuevas, ${res.result.merged} ya existían` +
          (res.result.changed ? `, ${res.result.changed} actualizadas` : "") +
          (res.skipped ? `, ${res.skipped} sin reconocer` : ""),
      );
      scheduleAutoSave();
    } catch (err) {
      notify(`Fallo al importar: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setWorking(null);
    }
  };

  return (
    <>
      <header className="topbar">
        <h1>Añadir</h1>
        <span className="muted small">
          Todos los caminos pasan por el mismo motor de identidad.
        </span>
      </header>
      <div className="content grid cols-2">
        <section>
          <h2>Importar mazo de Anki</h2>
          <div className="panel" style={{ padding: 14 }}>
            <p className="small muted">
              Los sub-decks se usan como nivel. Un mazo con 800 palabras que ya conoces no crea 800
              cards: las reconoce y sólo aparecen las que te faltan.
            </p>
            <input
              type="file"
              accept=".apkg,.colpkg"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onApkg(f);
                e.target.value = "";
              }}
            />
          </div>
        </section>

        <section>
          <h2>Pegar transcripción</h2>
          <div className="panel" style={{ padding: 14, display: "grid", gap: 10 }}>
            <label className="field">
              Título
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Video de X sobre Y"
              />
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Pega aquí la transcripción…"
              aria-label="Transcripción"
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn"
                disabled={text.trim().length < 20}
                onClick={() => void analyze()}
              >
                Analizar
              </button>
              <button
                className="btn primary"
                disabled={!preview.length}
                onClick={() => void createDeck()}
              >
                Crear mazo ({preview.length})
              </button>
            </div>
            {stats ? (
              <p className="small muted">
                {stats.total} palabras únicas · {stats.known} ya conocidas (descartadas) ·{" "}
                {stats.fresh} nuevas
              </p>
            ) : null}
          </div>
        </section>

        {preview.length > 0 ? (
          <section style={{ gridColumn: "1 / -1" }}>
            <h2>Candidatas</h2>
            <div className="panel" style={{ maxHeight: 320, overflowY: "auto" }}>
              {preview.map((c) => (
                <div className="row" key={c.lemma}>
                  <span style={{ font: "550 13.5px var(--mono)" }}>{c.lemma}</span>
                  <span className="tag">{c.kind}</span>
                  <span className="muted small">×{c.occurrences}</span>
                  <div className="grow" />
                  <span
                    className="muted small"
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "46ch",
                    }}
                  >
                    {c.bestSentence}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section style={{ gridColumn: "1 / -1" }}>
          <h2>Fuera de la v1</h2>
          <div className="panel" style={{ padding: 14 }}>
            <p className="small muted" style={{ maxWidth: "70ch" }}>
              PDF (fase 1) y OCR no están implementados. El resto de exclusiones —exportar a{" "}
              <code>.apkg</code>, sincronización, plugins, búsqueda semántica— están en{" "}
              <code>docs/plan.md</code> como decisiones informadas, no como olvidos.
            </p>
          </div>
        </section>
      </div>
      {working ? (
        <div className="busy" role="status">
          <span>{working}</span>
        </div>
      ) : null}
    </>
  );
}

async function translateMissing(
  prefs: import("../store").Prefs,
  candidates: Candidate[],
  notify: (m: string) => void,
): Promise<void> {
  const nodes = await db.nodes.toArray();
  const byLemma = new Map(nodes.map((n) => [n.lemma, n]));
  const units: { id: string; word: string; kind: "word" | "phrase" }[] = [];

  for (const c of candidates) {
    const node = byLemma.get(c.lemma);
    if (!node) continue;
    const sense = await db.senses.where("nodeId").equals(node.id!).first();
    if (sense && sense.translations.length > 0) continue;
    units.push({ id: `L${String(node.id).padStart(4, "0")}`, word: c.lemma, kind: c.kind });
  }
  if (!units.length) return;

  try {
    const { translateBatch } = await import("../translate");
    const got = await translateBatch(prefs.llm, units, prefs.targetLang);
    await db.transaction("rw", db.senses, async () => {
      for (const [id, translations] of got) {
        const sense = await db.senses
          .where("nodeId")
          .equals(Number(id.slice(1)))
          .first();
        if (!sense) continue;
        const set = new Set(sense.translations);
        for (const t of translations) set.add(t);
        await db.senses.update(sense.id!, {
          translations: [...set],
          translationSource: set.size === translations.length ? "ai" : sense.translationSource,
        });
      }
    });
    notify(`Traducidas ${got.size} de ${units.length}.`);
  } catch (err) {
    notify(`Traducción interrumpida: ${err instanceof Error ? err.message : String(err)}`);
  }
}

void hash;
