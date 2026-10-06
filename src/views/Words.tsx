import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { db, type Node } from "../db";
import { useApp } from "../store";
import { scheduleAutoSave } from "../backup";
import { retrievability } from "../srs";

type Sort = "lemma" | "due" | "known";

export default function Words() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("due");
  const [onlyUnknown, setOnlyUnknown] = useState(false);
  const [target, setTarget] = useState<Node | null>(null);

  const nodes = useLiveQuery(() => db.nodes.toArray(), []) ?? [];
  const senses = useLiveQuery(() => db.senses.toArray(), []) ?? [];
  const translations = useMemo(
    () => new Map(senses.map((s) => [s.nodeId, s.translations])),
    [senses],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const filtered = nodes.filter((n) => {
      if (onlyUnknown && n.known) return false;
      if (!q) return true;
      return (
        n.lemma.includes(q) ||
        (translations.get(n.id!) ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });

    const cmp: Record<Sort, (a: Node, b: Node) => number> = {
      lemma: (a, b) => a.lemma.localeCompare(b.lemma),
      // lo que más se me olvida primero
      due: (a, b) => retrievability(a.card, now) - retrievability(b.card, now),
      known: (a, b) => Number(b.known) - Number(a.known) || a.lemma.localeCompare(b.lemma),
    };
    return filtered.sort(cmp[sort]);
  }, [nodes, query, sort, onlyUnknown, translations]);

  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 33,
    overscan: 14,
  });

  const toggleKnown = async (node: Node) => {
    await db.nodes.update(node.id!, { known: node.known ? 0 : 1, updatedAt: Date.now() });
    scheduleAutoSave();
  };

  return (
    <>
      <header className="topbar">
        <h1>Palabras</h1>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por término o traducción…"
          aria-label="Buscar"
          style={{ maxWidth: 340 }}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={onlyUnknown}
            onChange={(e) => setOnlyUnknown(e.target.checked)}
          />
          sólo lo que no sé
        </label>
        <div className="grow" />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Ordenar"
          style={{ width: "auto" }}
        >
          <option value="due">Lo que más se me olvida</option>
          <option value="lemma">Alfabético</option>
          <option value="known">Conocidas primero</option>
        </select>
        <span className="muted small" style={{ fontVariantNumeric: "tabular-nums" }}>
          {rows.length}
        </span>
      </header>

      <div className="content table">
        <div className="trow thead">
          <span />
          <span>Término</span>
          <span>Traducción</span>
          <span>Origen</span>
          <span>Estado</span>
          <span />
        </div>

        <div ref={parent} style={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((v) => {
              const node = rows[v.index]!;
              const tr = translations.get(node.id!) ?? [];
              return (
                <div
                  key={node.id}
                  className="trow"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={node.known === 1}
                    onChange={() => void toggleKnown(node)}
                    aria-label={`Marcar ${node.lemma} como conocida`}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <span className="w">{node.lemma}</span>
                  <span
                    className="muted"
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {tr.slice(0, 3).join(" · ") || "—"}
                  </span>
                  <span className="tag">{node.kind === "phrase" ? "frase" : "palabra"}</span>
                  <span
                    className="pill"
                    title={`repetibilidad ${(retrievability(node.card) * 100).toFixed(0)}%`}
                  >
                    {node.known ? "conocida" : rLabel(node)}
                  </span>
                  <button
                    className="btn"
                    onClick={() => setTarget(node)}
                    style={{ minHeight: 26, padding: "2px 9px" }}
                  >
                    {node.known ? "⋯" : "detalle"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {target ? <NodeDialog node={target} onClose={() => setTarget(null)} /> : null}
    </>
  );
}

function rLabel(node: Node): string {
  if (!node.card || node.card.state === 0) return "nueva";
  return node.due <= Date.now() ? "vencida" : "en curso";
}

function NodeDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const unmark = useApp((s) => s.unmark);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const close = () => {
    ref.current?.close();
    onClose();
  };

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r)",
        padding: 18,
        maxWidth: 460,
        width: "90%",
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0 }}>{node.lemma}</h2>
        <span className="tag">{node.kind}</span>
        <div className="grow" />
        <button className="btn" onClick={close} style={{ minHeight: 28, padding: "2px 10px" }}>
          cerrar
        </button>
      </div>

      <p className="muted small" style={{ marginTop: 12 }}>
        {node.card
          ? `${node.card.reps} repasos · ${node.card.lapses} lapsos · estabilidad ${node.card.stability.toFixed(1)} d · repetibilidad ${(retrievability(node.card) * 100).toFixed(0)} %`
          : "Sin historial de repaso."}
      </p>

      {node.known ? (
        <div className="grid" style={{ gap: 10 }}>
          <p className="small" style={{ margin: 0 }}>
            ¿Por qué la desmarcas? Son dos intenciones distintas y el resultado es opuesto.
          </p>
          <button
            className="btn primary"
            onClick={() => {
              void unmark(node.id!, "reset");
              close();
            }}
          >
            No la sé — reiniciar historial
          </button>
          <button
            className="btn"
            onClick={() => {
              void unmark(node.id!, "due-now");
              close();
            }}
          >
            La sé, sólo quiero verla antes
          </button>
        </div>
      ) : (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Al marcarla como conocida desaparece de la generación de mazos y de las sesiones.
        </p>
      )}
    </dialog>
  );
}
