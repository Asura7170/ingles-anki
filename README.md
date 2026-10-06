# Segundo cerebro de vocabulario inglés

Aplicación web para estudiar inglés que reemplaza la capa de almacenamiento de Anki por una
**identidad de palabra unificada**. Cliente puro, sin servidor, offline-first.

## La idea

Anki te obliga a repetir palabras que ya conoces porque su unidad de identidad es **la nota del
mazo**, no **la palabra**. Aquí el SRS vive en el nodo de la palabra, y un mazo es una _query_
sobre el pool de nodos:

- Importar un mazo nuevo **no crea cards** de las palabras que ya tienes: las reconoce.
- Estudiar en un mazo actualiza el historial global de esa palabra, que se refleja en los demás.
- Borrar un mazo no destruye progreso.

```
nodes      ← identidad + SRS global (stable, difficulty, due)
senses     ← hijos; "bank" (banco) y "bank" (orilla) son distintos
sources    ← procedencia: una fila por (nodo, origen), nunca sobrescribe
examples   ← frases; la más corta gana como contexto de la card
relations  ← collocation / opposite / similarTo / partOf
reviewLog  ← bitácora con atribución por deck
exposure   ← exposición pasiva, SEPARADA del log (nunca se inyecta al scheduler)
```

El invariante central está en `src/ingest.ts`: **los cuatro caminos de entrada** (`.apkg`, texto,
PDF, IA) llaman a la misma función, así que todos heredan la deduplicación.

## Pila de palabras

- `compromise` para lematizar (verificado sobre 60 tokens reales: `ran→run`, `children→child`,
  `geese→goose`) + una tabla propia de comparativos, que ningún paquete JS cubre.
- `ts-fsrs` (FSRS-6, 0 dependencias) en vez de reimplementar SM-2.
- El diff de escritura es un port de `compare_answer()` de Anki
  (`rslib/src/typeanswer.rs`), que usa `difflib::SequenceMatcher` (Ratcliff/Obershelp) — **no** es
  LCS ni Levenshtein. Con tres desviaciones deliberadas documentadas en `src/diff.ts`.
- `fflate` + `fzstd` + `sql.js` para leer `.apkg` en un worker.
- Vite + React 19 + Dexie/IndexedDB. Sin servidor.

## Comandos

```bash
pnpm install
pnpm dev        # servidor de desarrollo
pnpm test       # vitest
pnpm coverage   # con umbrales por archivo
pnpm check      # oxlint + oxfmt + tsc
pnpm verify     # check + coverage + build
```

Usa [Vite+](https://viteplus.dev) (`vp`) para bundler, lint, format y tests.

## Estado

Fase 0 del plan, más la ingesta de texto. Funciona **sin ninguna API key**: importa un `.apkg` o
pega una transcripción y estudia. Configura un endpoint OpenAI-compatible en _Ajustes_ para traducir
lo que falta.

Pendiente: ingesta de PDF, chat con tool-calling, sentidos de OEWN, export a `.apkg`.

## Aviso

IndexadoDB se borra **siempre** con "borrar datos de navegación", y `navigator.storage.persist()`
no protege contra eso — ninguna API web puede. La única red real es _Ajustes → Vincular archivo de
respaldo_.

## Licencia

[MIT](LICENSE) — haz lo que quieras con esto.

## Datos de terceros

El código es MIT. Los datos de frecuencia de palabras que puedes cargar en
`public/frequency.json` tienen licencias propias y **copyleft**:

| Fuente                  | Licencia                                | Atribución                               |
| ----------------------- | --------------------------------------- | ---------------------------------------- |
| NGSL 1.2                | CC BY-SA 4.0                            | Browne, C., Culligan, B., & Phillips, J. |
| FrequencyWords `en_50k` | MIT (código) / CC BY-SA 4.0 (contenido) | Hermit Dave — OpenSubtitles              |

**No vienen incluidos.** Son opcionales: sin ellos la app funciona igual, el filtro se apoya
sólo en stopwords y en la marca `known`. Si los añades, mantén sus `LICENSE.txt` junto a los
datos y su atribución, y **no** deben tratarse como parte del software: filtrar, puntuar y ordenar
una lista de palabras puede构成 obra adaptada bajo CC BY-SA, y su §3(b) obligaría a relicenciar
todo el proyecto bajo CC BY-SA, incompatible con MIT.

Mantén los avisos de terceros fuera de la raíz del repo: si hay varios archivos de licencia en la
raíz, Licensee devuelve "other" y GitHub deja de mostrar el badge MIT.
