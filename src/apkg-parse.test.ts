import { describe, expect, it } from "vite-plus/test";
import { unzipSync, zipSync } from "fflate";
import initSqlJs from "sql.js";
import { rootOf } from "./apkg-format";
import { parseApkgBytes } from "./apkg-parse";

/**
 * El worker original hacía `SELECT id, flds FROM notes` — no `nid`, que no existe
 * en el esquema de Anki. Este archivo reconstruye un .apkg real para fijar ese
 * contrato, porque el error sólo aparecía al importar.
 *
 * Ahora los tests ejecutan `parseApkgBytes` de verdad. Antes mantenían una
 * réplica de sus queries: una réplica no falla cuando la query original cambia, y
 * por eso el bug de `nid` pasó la suite durante meses.
 */

const SQL = await initSqlJs({ wasmBinary: await wasm() });

async function wasm(): Promise<ArrayBuffer> {
  const { readFileSync } = await import("node:fs");
  const buf = readFileSync("./node_modules/sql.js/dist/sql-wasm.wasm");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

type Row = [number, string, number]; // nid, flds, did

const DECKS = {
  "1": { id: 1, name: "4000 Essential English Words" },
  "2": { id: 2, name: "4000 Essential English Words::Book 1" },
  "3": { id: 3, name: "4000 Essential English Words::Book 2" },
};

function buildApkg(opts: {
  notes: Row[];
  /** `true` = schema 18 (tabla decks); por defecto schema 11 (col.decks JSON) */
  schema18?: boolean;
  /** JSON de col.decks roto, para el camino de degradación. */
  brokenDecksJson?: boolean;
}): Uint8Array {
  const db = new SQL.Database();

  db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT)`);
  db.run(
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, nid INTEGER, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld INTEGER, csum INTEGER, flags INTEGER, data TEXT)`,
  );
  db.run(
    `CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, mod INTEGER, type INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)`,
  );

  if (opts.schema18) {
    db.run(
      `CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT, mod INTEGER, usn INTEGER, common TEXT, kind TEXT)`,
    );
    for (const [id, d] of Object.entries(DECKS)) {
      db.run(`INSERT INTO decks VALUES (?,?,0,0,'{}','normal')`, [Number(id), d.name]);
    }
  }

  db.run(`INSERT INTO col VALUES (1, ?, ?)`, [
    JSON.stringify({ 1: { flds: "Front\tBack\tExample" } }),
    opts.brokenDecksJson ? "{no es json" : JSON.stringify(DECKS),
  ]);

  for (const [nid, flds, did] of opts.notes) {
    db.run(`INSERT INTO notes (id, nid, mid, mod, usn, tags, flds) VALUES (?,?,1,0,0,'',?)`, [
      nid,
      nid,
      flds,
    ]);
    db.run(`INSERT INTO cards (id, nid, did, ord) VALUES (?,?,?,0)`, [nid, nid, did]);
  }

  // `export()` antes de `close()`: una base cerrada devuelve un buffer vacío.
  const exported = db.export();
  db.close();
  return zipSync({
    "collection.anki2": new Uint8Array(exported),
    media: new TextEncoder().encode("{}"),
  });
}

/** `parseApkgBytes` devuelve la unión del error del worker, pero aquí siempre `ok`. */
const parse = (apkg: Uint8Array) => {
  const buf = apkg.buffer.slice(apkg.byteOffset, apkg.byteOffset + apkg.byteLength);
  const out = parseApkgBytes(buf as ArrayBuffer, SQL);
  if (!out.ok) throw new Error(out.error);
  return out;
};

const SAMPLE: Row[] = [
  [1, ["run", "correr", "She runs every morning without fail."].join("\x1f"), 2],
  [2, ["study", "estudiar", "He studies hard for his examinations."].join("\x1f"), 2],
  [3, ["startle", "asustar", "The noise startled the horses."].join("\x1f"), 3],
];

describe("el .apkg se parsea", () => {
  it("schema 11 (col.decks en JSON)", () => {
    const r = parse(buildApkg({ notes: SAMPLE }));
    expect(r.ok).toBe(true);
    expect(r.notes).toHaveLength(3);
    expect(r.notes[0]!.deckName).toBe("4000 Essential English Words::Book 1");
  });

  it("schema 18 (tabla decks) da el mismo resultado", () => {
    const r = parse(buildApkg({ notes: SAMPLE, schema18: true }));
    expect(r.ok).toBe(true);
    expect(r.notes.map((n) => n.deckName)).toEqual([
      "4000 Essential English Words::Book 1",
      "4000 Essential English Words::Book 1",
      "4000 Essential English Words::Book 2",
    ]);
  });

  it("la PK de notes es `id`, y esa query no lanza", () => {
    // El bug: `SELECT nid FROM notes` → "no such column: nid".
    const apkg = buildApkg({ notes: SAMPLE });
    expect(() => parse(apkg)).not.toThrow();
    expect(parse(apkg).notes.map((n) => n.noteId)).toEqual([1, 2, 3]);
  });

  it("asigna el sub-deck como nivel", () => {
    const r = parse(buildApkg({ notes: SAMPLE }));
    expect(r.notes[0]!.level).toBe("Book 1");
    expect(r.notes[2]!.level).toBe("Book 2");
  });

  it("todos los decks comparten la misma raíz", () => {
    const r = parse(buildApkg({ notes: SAMPLE }));
    expect([...new Set(r.notes.map((n) => rootOf(n.deckName)))]).toEqual([
      "4000 Essential English Words",
    ]);
  });

  it("separa los campos por \\x1f y limpia el HTML", () => {
    const r = parse(
      buildApkg({
        notes: [[1, ["<b>run</b>", "correr", "<div>She <i>runs</i>.</div>"].join("\x1f"), 2]],
      }),
    );
    expect(r.notes[0]!.fields).toEqual(["run", "correr", "She runs."]);
  });

  it("col.decks con JSON inválido degrada a 'Sin deck' en vez de perder todo", () => {
    const r = parse(buildApkg({ notes: SAMPLE, brokenDecksJson: true }));
    expect(r.notes).toHaveLength(3);
    expect(r.notes.every((n) => n.deckName === "Sin deck")).toBe(true);
  });

  it("sin collection.anki2 lanza con un mensaje útil", () => {
    const roto = zipSync({ media: new TextEncoder().encode("{}") });
    expect(() => parse(roto)).toThrow(/collection\.anki2/);
  });

  it("deck vacío → notes vacío, no error", () => {
    expect(parse(buildApkg({ notes: [] })).notes).toEqual([]);
  });
});

describe("el apkg se comprime y descomprime", () => {
  it("el round-trip preserva la base SQLite", () => {
    const files = unzipSync(buildApkg({ notes: SAMPLE }));
    expect(files["collection.anki2"]).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(files.media!)).toBe("{}");
  });
});
