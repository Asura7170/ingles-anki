import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useApp } from "./store";
import { db } from "./db";
import Decks from "./views/Decks";
import Ingest from "./views/Ingest";
import Words from "./views/Words";
import Study from "./views/Study";
import Settings from "./views/Settings";

const TABS = [
  { id: "decks", label: "Mazos" },
  { id: "ingest", label: "Añadir" },
  { id: "words", label: "Palabras" },
  { id: "settings", label: "Ajustes" },
] as const;

export default function App() {
  const { view, setView, boot, busy, toast, queue, endSession } = useApp();

  useEffect(() => {
    void boot();
  }, [boot]);

  const counts = useLiveQuery(async () => {
    const [nodes, known, decks] = await Promise.all([
      db.nodes.count(),
      db.nodes.where("known").equals(1).count(),
      db.decks.count(),
    ]);
    return { nodes, known, decks };
  }, []);

  const studying = queue.length > 0;

  return (
    <div className="app">
      <nav className="rail" aria-label="Secciones">
        <div className="brand">Vocabulario</div>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => (studying && tab.id === "words" ? undefined : setView(tab.id))}
            aria-current={view === tab.id ? "page" : undefined}
          >
            <span>{tab.label}</span>
            {tab.id === "decks" && counts ? (
              <span className="muted small">{counts.decks}</span>
            ) : null}
            {tab.id === "words" && counts ? (
              <span className="muted small">
                {counts.known}/{counts.nodes}
              </span>
            ) : null}
          </button>
        ))}
        <div className="grow" />
        {studying ? (
          <button onClick={endSession}>
            <span>Salir de la sesión</span>
            <kbd>Esc</kbd>
          </button>
        ) : null}
      </nav>

      <main className="main">{studying ? <Study /> : <ViewSwitch view={view} />}</main>

      {busy ? (
        <div className="busy" role="status">
          <span>{busy}</span>
        </div>
      ) : null}
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function ViewSwitch({ view }: { view: string }) {
  switch (view) {
    case "ingest":
      return <Ingest />;
    case "words":
      return <Words />;
    case "settings":
      return <Settings />;
    default:
      return <Decks />;
  }
}
