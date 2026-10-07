import { useState } from "react";
import { db } from "../db";
import { ingest, hash } from "../ingest";
import { extractCandidates, loadFrequency, freqRank, type Candidate } from "../identity";
import { findOrAddSourceText } from "../ingest";
import { importApkg } from "../apkg";
import { useApp } from "../store";
import { scheduleAutoSave } from "../backup";
import { fillMissingTranslations } from "../fill-senses";

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
      const result = await createDeckFromText({ name, text, preview });

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

/**
 * Persiste el texto como origen, fusiona sus palabras y cierra un mazo.
 *
 * El orden importa y no es intercambiable: `ingest()` debe correr antes de leer
 * `db.nodes`, porque el `byLemma` que resuelve los ids para la exposición sólo
 * existe después de la fusión. Escribir el mazo antes de la exposición dejaría
 * un mazo vacío si `bulkAdd` fallara.
 */
async function createDeckFromText({
  name,
  text,
  preview,
}: {
  name: string;
  text: string;
  preview: Candidate[];
}): Promise<{ created: number; merged: number }> {
  const sourceTextId = await findOrAddSourceText(name, text);

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

  return result;
}

async function translateMissing(
  prefs: import("../store").Prefs,
  candidates: Candidate[],
  notify: (m: string) => void,
): Promise<void> {
  // `createDeck` acaba de fusionar los candidatos, así que se resuelve por
  // lemma contra los nodos ya persistidos en vez de usar los ids del preview,
  // que no existen todavía en la base.
  const nodes = await db.nodes.toArray();
  const byLemma = new Map(nodes.map((n) => [n.lemma, n]));
  const pending = candidates.flatMap((c) => {
    const node = byLemma.get(c.lemma);
    return node ? [{ id: node.id!, lemma: node.lemma, kind: node.kind }] : [];
  });

  try {
    const { translated, added } = await fillMissingTranslations(
      prefs.llm,
      prefs.targetLang,
      pending,
    );
    if (added) notify(`Traducidas ${translated} palabras (${added} nuevas).`);
  } catch (err) {
    notify(`Traducción interrumpida: ${err instanceof Error ? err.message : String(err)}`);
  }
}

void hash;
