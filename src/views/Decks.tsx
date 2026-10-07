import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { deckStats, DEFAULT_DAILY_NEW_LIMIT, type DeckStats } from "../decks";
import { useApp } from "../store";

export default function Decks() {
  const decks = useLiveQuery(() => db.decks.toArray(), []) ?? [];
  const startSession = useApp((s) => s.startSession);
  const busy = useApp((s) => s.busy);

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
          <div className="grid cols-2">
            {decks.map((deck) => (
              <DeckCard key={deck.id} deck={deck} onStart={startSession} disabled={Boolean(busy)} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function DeckCard({
  deck,
  onStart,
  disabled,
}: {
  deck: import("../db").Deck;
  onStart: (deck: import("../db").Deck) => void;
  disabled: boolean;
}) {
  const stats = useLiveQuery<DeckStats>(() => deckStats(deck), [deck.id, deck.name, deck.kind]);
  const pending =
    (stats?.due ?? 0) + Math.min(stats?.fresh ?? 0, deck.dailyNewLimit ?? DEFAULT_DAILY_NEW_LIMIT);

  return (
    <div className="panel">
      <div className="row" style={{ padding: "12px 14px" }}>
        <div className="grow">
          <div style={{ fontWeight: 550 }}>{deck.name}</div>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}
