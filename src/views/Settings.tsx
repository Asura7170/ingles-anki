import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useApp } from "../store";
import { listVoices } from "../tts";
import {
  autoSave,
  backupFileName,
  exportToDisk,
  importFromFile,
  linkBackupFile,
  regrantBackup,
} from "../backup";
import { purgeOrphanTexts } from "../purge";

const TARGET_LANGS = ["español", "inglés", "francés", "portugués", "alemán", "italiano", "japonés"];
const TTS_LANGS = ["en-US", "en-GB", "en-AU", "en-IN"];

export default function Settings() {
  const { prefs, setPrefs, notify } = useApp();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    void listVoices().then(setVoices);
    void navigator.storage
      ?.estimate?.()
      .then((e) => setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
  }, []);

  const backupName = useLiveQuery(() => backupFileName(), []);

  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

  return (
    <>
      <header className="topbar">
        <h1>Ajustes</h1>
      </header>
      <div className="content grid cols-2">
        <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }}>
          <h2 style={{ margin: 0 }}>IA</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Endpoint OpenAI-compatible. CORS no tiene arreglo del lado cliente: el servidor que
            configures debe enviarlo. LM Studio, Ollama, llama.cpp y vLLM lo hacen;{" "}
            <code>api.openai.com</code> directo desde el navegador no.
          </p>
          <label className="field">
            Base URL
            <input
              type="text"
              value={prefs.llm.baseUrl}
              onChange={(e) => void setPrefs({ llm: { ...prefs.llm, baseUrl: e.target.value } })}
              placeholder="http://localhost:1234/v1"
            />
          </label>
          <label className="field">
            API key (opcional en local)
            <input
              type="password"
              value={prefs.llm.apiKey}
              onChange={(e) => void setPrefs({ llm: { ...prefs.llm, apiKey: e.target.value } })}
              autoComplete="off"
            />
          </label>
          <label className="field">
            Modelo
            <input
              type="text"
              value={prefs.llm.model}
              onChange={(e) => void setPrefs({ llm: { ...prefs.llm, model: e.target.value } })}
              placeholder="qwen3-8b, gpt-4o-mini, gpt-oss-120b…"
            />
          </label>
          <label className="field">
            Idioma destino de las traducciones
            <select
              value={prefs.targetLang}
              onChange={(e) => void setPrefs({ targetLang: e.target.value })}
            >
              {TARGET_LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Estudio</h2>
          <label className="field">
            Umbral de acierto para <code>Difícil</code> — {prefs.threshold.toFixed(2)}
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.05}
              value={prefs.threshold}
              onChange={(e) => void setPrefs({ threshold: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            Palabras nuevas por sesión — {prefs.dailyNewLimit}
            <input
              type="range"
              min={5}
              max={80}
              step={5}
              value={prefs.dailyNewLimit}
              onChange={(e) => void setPrefs({ dailyNewLimit: Number(e.target.value) })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={prefs.typingRequired}
              onChange={(e) => void setPrefs({ typingRequired: e.target.checked })}
            />
            Exigir escritura cuando hay frase
          </label>
          <p className="small muted" style={{ margin: 0 }}>
            Sin frase no hay recuperación contextual posible, así que la escritura nunca es
            obligatoria ahí. Repetir estudio después de un acierto no produce aprendizaje medible
            (Karpicke &amp; Roediger 2008): por eso el writing es el mecanismo, no un extra.
          </p>
        </section>

        <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Voz</h2>
          <label className="field">
            Acento
            <select
              value={prefs.ttsLang}
              onChange={(e) => void setPrefs({ ttsLang: e.target.value })}
            >
              {TTS_LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Velocidad — {prefs.ttsRate.toFixed(2)}×
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={prefs.ttsRate}
              onChange={(e) => void setPrefs({ ttsRate: Number(e.target.value) })}
            />
          </label>
          <p className="small muted" style={{ margin: 0 }}>
            {voices.length > 0
              ? `${voices.length} voces inglesas disponibles (${voices.filter((v) => v.localService).length} locales).`
              : "Cargando voces…"}
          </p>
        </section>

        <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Respaldo</h2>
          <p className="small muted" style={{ margin: 0 }}>
            IndexedDB se borra <strong>siempre</strong> con «borrar datos de navegación», y
            <code> navigator.storage.persist()</code> no protege contra eso. El archivo en disco es
            el único red real.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn primary"
              onClick={() =>
                void linkBackupFile().then((p) =>
                  notify(
                    p === "granted"
                      ? "Respaldo automático enlazado."
                      : "Permiso denegado: sigue disponible la descarga manual.",
                  ),
                )
              }
            >
              Vincular archivo de respaldo
            </button>
            <button
              className="btn"
              onClick={() => void autoSave().then((r) => notify(`Guardado: ${r}`))}
            >
              Guardar ahora
            </button>
            <button className="btn" onClick={() => void exportToDisk()}>
              Descargar copia
            </button>
            <label className="btn" style={{ cursor: "pointer" }}>
              Restaurar copia
              <input
                type="file"
                accept="application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    void importFromFile(f)
                      .then(() => notify("Copia restaurada."))
                      .catch((err: unknown) => notify(`Fallo: ${String(err)}`));
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {backupName ? (
            <button
              className="btn"
              onClick={() =>
                void regrantBackup().then((p) =>
                  notify(p === "granted" ? "Permiso renewado." : "Permiso denegado."),
                )
              }
            >
              Re-autorizar «{backupName}»
            </button>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              Sin archivo vinculado. El permiso no persiste entre sesiones: tras recargar hay que
              pulsar «Re-autorizar».
            </p>
          )}
          {quota ? (
            <p className="small muted" style={{ margin: 0 }}>
              Almacenamiento: {mb(quota.usage)} de {mb(quota.quota)}
            </p>
          ) : null}
        </section>

        {/* Sección propia y no dentro de "Respaldo": restaurar *sobrescribe* todo
            y limpiar *borra* filas. Juntarlos mezcla dos operaciones con
            consecuencias opuestas. */}
        <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Limpieza</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Cada vez que se pegaba una transcripción quedaba guardada, y <code>sourceTexts</code> no
            tiene ninguna pantalla donde verla. Borrar un mazo ya se lleva la suya; esto quita las
            que sobraron de antes.
          </p>
          <div>
            <button
              className="btn"
              onClick={() =>
                void purgeOrphanTexts().then((n) =>
                  notify(
                    n
                      ? `${n} transcripción${n === 1 ? "" : "es"} borrada${n === 1 ? "" : "s"}. Sus palabras NO se borran: quedan sin mazo.`
                      : "No hay transcripciones huérfanas.",
                  ),
                )
              }
            >
              Borrar transcripciones huérfanas
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
