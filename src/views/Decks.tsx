import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Deck } from "../db";
import { allDeckStats, type DeckStats } from "../decks";
import { deleteDeck } from "../purge";
import { useApp } from "../store";

export default function Decks() {
  // `createdAt` desc, no el orden de `++id`: los mazos se reimportan y el que
  // acabas de traer es el que vas a estudiar. `toArray` + sort en vez de
  // `orderBy` porque `createdAt` no está indexado y la tabla es de un puñado.
  const decks =
    useLiveQuery(async () => {
      const rows = await db.decks.toArray();
      return rows.sort((a, b) => b.createdAt - a.createdAt);
    }, []) ?? [];
  // Una consulta para todas las tarjetas. Antes cada `DeckCard` tenía la suya, y
  // `deckStats` terminaba en `db.sources.toArray()`: 20 mazos = 20 escaneos
  // completos y 20 suscripciones vivas que se relanzaban en cada cambio.
  const stats = useLiveQuery(() => allDeckStats(decks), [decks]);
  const startSession = useApp((s) => s.startSession);
  const busy = useApp((s) => s.busy);
  const [filter, setFilter] = useState("");

  const shown = decks.filter((d) => d.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <>
      <header className="topbar">
        <h1>Mazos</h1>
        <span className="muted small">
          Un mazo es una vista sobre el pool de palabras, no un contenedor.
        </span>
      </header>
      <div className="content grid">
        {decks.length === 0 ? (
          <div className="panel" style={{ padding: 28 }}>
            <p style={{ maxWidth: "58ch" }}>
              Todavía no hay mazos. Importa un <code>.apkg</code> de Anki o pega una transcripción
              en <strong>Añadir</strong>. El SRS vive en la palabra, no en el mazo: importar un mazo
              nuevo nunca te obliga a reaprender lo que ya sabes.
            </p>
          </div>
        ) : (
          <>
            {decks.length > 3 ? (
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filtrar mazos por nombre"
                aria-label="Filtrar mazos por nombre"
                style={{ maxWidth: 320 }}
              />
            ) : null}
            {shown.length === 0 ? (
              <p className="muted">Ningún mazo se llama «{filter.trim()}».</p>
            ) : (
              <div className="grid cols-2">
                {shown.map((deck) => (
                  <DeckCard
                    key={deck.id}
                    deck={deck}
                    stats={deck.id === undefined ? undefined : stats?.get(deck.id)}
                    onStart={startSession}
                    disabled={Boolean(busy)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function DeckCard({
  deck,
  stats,
  onStart,
  disabled,
}: {
  deck: Deck;
  stats?: DeckStats;
  onStart: (deck: Deck) => void;
  disabled: boolean;
}) {
  // La misma fuente que `startSession` pasa a `buildQueue`. Antes la tarjeta
  // contaba con `deck.dailyNewLimit` (que nadie rellenaba) y el store usaba
  // `prefs.dailyNewLimit`: el botón prometía una cola distinta de la que llegaba.
  const newLimit = useApp((s) => s.prefs.dailyNewLimit);
  const notify = useApp((s) => s.notify);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const pending = (stats?.due ?? 0) + Math.min(stats?.fresh ?? 0, newLimit);
  // Cota superior de lo que se va: las palabras sin marcar. Las compartidas con
  // otro mazo sobreviven igual, así que el botón nunca promete más de lo que
  // puede quitar — que es el peor error posible en un borrado.
  const doomed = stats ? stats.total - stats.known : 0;

  // Qué se lleva el borrado, en una frase. Un máximo, nunca una promesa: si la
  // transcripción la comparte otro mazo, `deleteDeck` conservará esas palabras y
  // el aviso posterior lo explica. Y un mazo importado no tiene transcripción,
  // así que no se nombra.
  const parts: string[] = [];
  if (doomed) parts.push(`${doomed} palabra${doomed === 1 ? "" : "s"}`);
  if (deck.sourceTextIds?.length) parts.push("la transcripción");
  const confirmLabel = `¿Seguro? Borrar mazo${parts.length ? `, ${parts.join(" y ")}` : ""}`;

  return (
    <div className="panel">
      <div className="row" style={{ padding: "12px 14px" }}>
        <div className="grow">
          {editing ? (
            <RenameField deck={deck} onDone={() => setEditing(false)} onNotify={notify} />
          ) : (
            <div style={{ fontWeight: 550 }}>{deck.name}</div>
          )}
          <div className="muted small">
            {stats ? `${stats.total} palabras · ${stats.known} conocidas` : "calculando…"}
          </div>
        </div>
        <span className="tag">{deck.kind === "import" ? "importado" : "generado"}</span>
      </div>
      <div className="row">
        <Stat label="Vencidas" value={stats?.due ?? 0} />
        <Stat label="Nuevas" value={stats?.fresh ?? 0} />
        <Stat label="En curso" value={stats?.learning ?? 0} />
        <div className="grow" />
        {editing ? null : (
          <>
            <button className="btn" onClick={() => setEditing(true)} disabled={disabled}>
              Renombrar
            </button>
            {confirming ? (
              <button
                className="btn"
                onClick={() => {
                  setConfirming(false);
                  void removeDeck(deck, notify);
                }}
              >
                {confirmLabel}
              </button>
            ) : (
              <button className="btn" onClick={() => setConfirming(true)} disabled={disabled}>
                Borrar
              </button>
            )}
          </>
        )}
        <button
          className="btn primary"
          disabled={disabled || pending === 0}
          onClick={() => void onStart(deck)}
        >
          Estudiar {pending > 0 ? pending : ""}
        </button>
      </div>
    </div>
  );
}

/**
 * El borrado vive en `purge.ts`, no aquí: la cascada de huérfanos la necesita
 * también la pestaña Palabras, y en un componente no se puede probar sin DOM.
 */
async function removeDeck(deck: Deck, notify: (msg: string) => void): Promise<void> {
  const { words, kept, texts, shared } = await deleteDeck(deck);
  const parts = [`Mazo «${deck.name}» borrado.`];
  if (words || kept) {
    parts.push(
      `${words} palabra${words === 1 ? "" : "s"} eliminada${words === 1 ? "" : "s"}` +
        (kept ? `, ${kept} conservada${kept === 1 ? "" : "s"} por estar marcada` : "") +
        ".",
    );
  }
  if (texts) parts.push("Transcripción eliminada; no queda en el backup.");
  // La confirmación promete un máximo de palabras, y con la transcripción
  // compartida no se puede cumplir. Sin esta línea el usuario ve "Borrar mazo y
  // 12 palabras" y luego un aviso que no menciona ninguna palabra.
  if (shared) {
    parts.push(
      `Se conserva la transcripción y sus palabras: la comparten ${shared} mazo${shared === 1 ? "" : "s"}.`,
    );
  }
  notify(parts.join(" "));
}

function RenameField({
  deck,
  onDone,
  onNotify,
}: {
  deck: Deck;
  onDone: () => void;
  onNotify: (msg: string) => void;
}) {
  const [name, setName] = useState(deck.name);

  const save = async () => {
    const trimmed = name.trim();
    // Nombre vacío = no hacer nada. Borrar el nombre dejaría un mazo sin
    // identidad en la lista, y `db.decks` indexa `name`.
    if (!trimmed || trimmed === deck.name) return onDone();
    // `decks.name` está indexado pero NO es único (`nodes.lemma` sí lo es, con
    // `&`). Dos mazos con el mismo nombre son indistinguibles en la lista y en
    // cualquier búsqueda por texto.
    const clash = await db.decks
      .filter((d) => d.id !== deck.id && d.name.trim().toLowerCase() === trimmed.toLowerCase())
      .first();
    if (clash) {
      onNotify(`Ya existe un mazo llamado «${trimmed}».`);
      return;
    }
    await db.decks.update(deck.id!, { name: trimmed });
    onNotify(`Mazo renombrado a «${trimmed}».`);
    onDone();
  };

  return (
    <input
      type="text"
      value={name}
      aria-label={`Nuevo nombre para ${deck.name}`}
      autoFocus
      onChange={(e) => setName(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void save();
        if (e.key === "Escape") onDone();
      }}
    />
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}
