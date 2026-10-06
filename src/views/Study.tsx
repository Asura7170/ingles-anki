import { useEffect, useMemo, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Ease } from "../db";
import { useApp } from "../store";
import { blankSentence } from "../identity";
import { speak, stop as stopTts } from "../tts";
import type { Token } from "../diff";

const BUTTONS: { ease: Ease; label: string; key: string }[] = [
  { ease: 1, label: "Otra vez", key: "1" },
  { ease: 2, label: "Difícil", key: "2" },
  { ease: 3, label: "Bien", key: "3" },
  { ease: 4, label: "Fácil", key: "4" },
];

export default function Study() {
  const {
    queue,
    pos,
    revealed,
    typed,
    comparison,
    suggested,
    typingHint,
    prefs,
    deck,
    setTyped,
    reveal,
    advance,
    notify,
  } = useApp();

  const item = queue[pos];
  const inputRef = useRef<HTMLInputElement>(null);
  const wordRef = useRef<HTMLButtonElement>(null);

  const sense = useLiveQuery(
    () => (item ? db.senses.where("nodeId").equals(item.node.id!).first() : undefined),
    [item?.node.id],
  );

  const blank = useMemo(
    () => (item?.sentence ? blankSentence(item.sentence, item.node) : null),
    [item?.sentence, item?.node.lemma],
  );

  const sentence = item?.sentence;
  const hasContext = Boolean(sentence && blank);

  // Prefetch de la traducción de la frase: la primera vez que la volteas.
  useEffect(() => {
    if (!revealed || !sentence || sense?.sentenceTranslation || !prefs.llm.model) return;
    let cancelled = false;
    void (async () => {
      const { translateSentence } = await import("../translate");
      try {
        const t = await translateSentence(prefs.llm, sentence, prefs.targetLang);
        if (!cancelled && t) {
          const fresh = await db.senses.where("nodeId").equals(item!.node.id!).first();
          if (fresh) await db.senses.update(fresh.id!, { sentenceTranslation: t });
        }
      } catch {
        // Sin traducción de frase: la card sigue siendo útil.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revealed, sentence, sense?.sentenceTranslation, prefs, item]);

  const play = (text: string) => void speak(text, { lang: prefs.ttsLang, rate: prefs.ttsRate });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (e.key === "Escape") {
        stopTts();
        return;
      }
      if (!revealed && (e.key === "Enter" || e.key === " ")) {
        if (typing && e.key === " " && inputRef.current) return;
        e.preventDefault();
        if (typing && e.key === "Enter") inputRef.current?.blur();
        reveal();
        return;
      }
      if (revealed && e.key === "Enter" && typing) {
        e.preventDefault();
        advance(suggested ?? 3);
        return;
      }
      if (revealed && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        advance(Number(e.key) as Ease);
        return;
      }
      if (!typing && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        if (sentence) play(sentence);
        return;
      }
      if (!typing && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        wordRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!item) return null;
  const { node } = item;
  const translations = sense?.translations ?? [];

  return (
    <div className="study">
      <header className="topbar">
        <h1>{deck?.name ?? "Sesión"}</h1>
        <div className="progress" aria-hidden="true">
          <i style={{ width: `${Math.round((pos / queue.length) * 100)}%` }} />
        </div>
        <span className="muted small" style={{ fontVariantNumeric: "tabular-nums" }}>
          {pos + 1} / {queue.length}
        </span>
      </header>

      <div className="study-body">
        <div className="cloze">
          {hasContext ? (
            <p className="sentence">
              {blank!.before}
              <span className="blank" aria-label="palabra oculta" />
              {blank!.after}
            </p>
          ) : (
            <>
              <p className="muted small" style={{ marginBottom: 8 }}>
                Sin frase disponible — escribe el término de memoria.
              </p>
              <div className="word-only">{node.lemma}</div>
            </>
          )}

          <div className="audio">
            {hasContext ? (
              <button
                className="btn"
                onClick={() => sentence && play(sentence)}
                disabled={!sentence}
              >
                <kbd>R</kbd> Escuchar la frase
              </button>
            ) : null}
            <button ref={wordRef} className="btn" onClick={() => play(node.lemma)}>
              <kbd>W</kbd> Escuchar la palabra
            </button>
          </div>

          {!revealed ? (
            <>
              {typingHint ? <p className="hint">Escribe la palabra para revelar.</p> : null}
              <input
                ref={inputRef}
                type="text"
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                lang="en"
                aria-label="Escribe la palabra en inglés"
                placeholder="escribe la palabra…"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                style={{
                  font: "500 19px var(--mono)",
                  textAlign: "center",
                  maxWidth: 380,
                  margin: "0 auto",
                }}
              />
            </>
          ) : (
            <Revealed
              comparison={comparison}
              typed={typed}
              answer={node.lemma}
              translations={translations}
              sentence={sentence}
              sentenceTranslation={sense?.sentenceTranslation}
              onRetry={() => {
                useApp.setState({ revealed: false, typed: "", comparison: null, suggested: null });
                notify("Escribe de nuevo.");
              }}
            />
          )}
        </div>
      </div>

      <div className="answerbar">
        {revealed ? (
          <div className="grades">
            {BUTTONS.map((b) => (
              <button
                key={b.ease}
                className="btn"
                data-suggested={suggested === b.ease}
                onClick={() => void advance(b.ease)}
              >
                <span>{b.label}</span>
                <kbd>{b.key}</kbd>
              </button>
            ))}
          </div>
        ) : (
          <button className="btn primary wide" onClick={reveal} style={{ minHeight: 46 }}>
            Mostrar reverso <kbd>Enter</kbd>
          </button>
        )}
      </div>
    </div>
  );
}

function Revealed({
  comparison,
  typed,
  answer,
  translations,
  sentence,
  sentenceTranslation,
  onRetry,
}: {
  comparison: import("../diff").Comparison | null;
  typed: string;
  answer: string;
  translations: string[];
  sentence?: string;
  sentenceTranslation?: string;
  onRetry: () => void;
}) {
  const wroteSomething = typed.trim().length > 0;

  return (
    <div>
      {wroteSomething && comparison ? (
        <>
          <div className="diff" aria-label="lo que escribiste">
            {comparison.typedLine.map((t, i) => (
              <Token key={i} token={t} />
            ))}
          </div>
          <div className="answer" aria-label="respuesta correcta">
            {answer}
          </div>
          {!comparison.exact ? (
            <p className="muted small">
              <button
                className="btn"
                onClick={onRetry}
                style={{ minHeight: 26, padding: "2px 9px" }}
              >
                Reintentar
              </button>
            </p>
          ) : null}
        </>
      ) : (
        <div className="answer">{answer}</div>
      )}

      {translations.length > 0 ? (
        <div className="translations">
          {translations.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      ) : (
        <p className="muted small">Sin traducción. Configura un endpoint LLM en Ajustes.</p>
      )}

      {sentence ? (
        <p className="sentence-tr">
          {sentence}
          <br />
          {sentenceTranslation ? (
            <span>{sentenceTranslation}</span>
          ) : (
            <span className="muted">traduciendo la frase…</span>
          )}
        </p>
      ) : null}
    </div>
  );
}

function Token({ token }: { token: Token }) {
  if (token.kind === "missing" && token.text === "") return <span className="m">_</span>;
  return (
    <span className={token.kind === "good" ? "g" : token.kind === "bad" ? "b" : "m"}>
      {token.text}
    </span>
  );
}
