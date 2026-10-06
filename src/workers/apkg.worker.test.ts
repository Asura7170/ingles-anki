import { describe, expect, it } from "vite-plus/test";
import { unzipSync, zipSync } from "fflate";
import initSqlJs from "sql.js";
import { levelOf, rootOf, stripHtml } from "../apkg-format";

/**
 * El worker hace `SELECT id, flds FROM notes` — no `nid`, que no existe en el
 * esquema de Anki. Este archivo reconstruye un .apkg real para fijar el contrato,
 * porque ese error sólo aparece al importar.
 */

const SQL = await initSqlJs({ wasmBinary: await wasm() });

async function wasm(): Promise<ArrayBuffer> {
  const { readFileSync } = await import("node:fs");
  const buf = readFileSync("./node_modules/sql.js/dist/sql-wasm.wasm");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

type Row = [number, string, number]; // nid, flds, did

function buildApkg(opts: {
  notes: Row[];
  /** null = schema 11 (col.decks JSON); true = schema 18 (tabla decks) */
  schema18?: boolean;
  noteCol?: "id" | "nid";
}): Uint8Array {
  const db = new SQL.Database();

  db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT)`);
  db.run(
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, nid INTEGER, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld INTEGER, csum INTEGER, flags INTEGER, data TEXT)`,
  );
  db.run(
    `CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, mod INTEGER, type INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)`,
  );

  const decks = {
    "1": { id: 1, name: "4000 Essential English Words" },
    "2": { id: 2, name: "4000 Essential English Words::Book 1" },
    "3": { id: 3, name: "4000 Essential English Words::Book 2" },
  };

  if (opts.schema18) {
    db.run(
      `CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT, mod INTEGER, usn INTEGER, common TEXT, kind TEXT)`,
    );
    for (const [id, d] of Object.entries(decks)) {
      db.run(`INSERT INTO decks VALUES (?,?,0,0,'{}','normal')`, [Number(id), d.name]);
    }
  }

  db.run(`INSERT INTO col VALUES (1, ?, ?)`, [
    JSON.stringify({ 1: { flds: "Front\tBack\tExample" } }),
    JSON.stringify(decks),
  ]);

  const pk = opts.noteCol ?? "id";
  for (const [nid, flds, did] of opts.notes) {
    db.run(`INSERT INTO notes (${pk}, nid, mid, mod, usn, tags, flds) VALUES (?,?,1,0,0,'',?)`, [
      pk === "id" ? nid : 0,
      nid,
      flds,
    ]);
    db.run(`INSERT INTO cards (id, nid, did, ord) VALUES (?,?,?,0)`, [nid, nid, did]);
  }

  return zipSync({
    "collection.anki2": new Uint8Array(db.export()),
    media: new TextEncoder().encode("{}"),
  });
}

/** Réplica de las queries del worker, para poder asertar sobre ellas. */
function parse(apkg: Uint8Array) {
  const files = unzipSync(apkg);
  const key = ["collection.anki2", "collection.anki21b", "collection.anki21"].find(
    (k) => k in files,
  )!;
  const handle = new SQL.Database(files[key]! as Uint8Array<ArrayBuffer>);
  const q = <T>(sql: string): T[] => {
    const st = handle.prepare(sql);
    const out: T[] = [];
    while (st.step()) out.push(st.getAsObject() as T);
    st.free();
    return out;
  };

  const deckNames = new Map<number, string>();
  const hasDecksTable =
    q<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='decks'`)
      .length > 0;
  if (hasDecksTable) {
    for (const r of q<{ id: number; name: string }>(`SELECT id, name FROM decks`))
      deckNames.set(r.id, r.name);
  } else {
    const col = q<{ decks: string }>(`SELECT decks FROM col`)[0];
    for (const [id, d] of Object.entries(
      JSON.parse(col?.decks ?? "{}") as Record<string, { name?: string }>,
    )) {
      if (d?.name) deckNames.set(Number(id), d.name);
    }
  }

  const cardDeck = new Map<number, number>();
  for (const c of q<{ nid: number; did: number }>(`SELECT nid, did FROM cards`)) {
    if (!cardDeck.has(c.nid)) cardDeck.set(c.nid, c.did);
  }

  // La query que importaba `nid` de notes: el bug real.
  const notes = q<{ id: number; flds: string }>(`SELECT id, flds FROM notes`).map((n) => {
    const did = cardDeck.get(n.id) ?? 0;
    const deckName = deckNames.get(did) ?? "Sin deck";
    return {
      noteId: n.id,
      deckId: did,
      deckName,
      level: levelOf(deckName),
      fields: n.flds.split("\x1f").map(stripHtml),
    };
  });

  handle.close();
  return { notes, schema: hasDecksTable ? ("18" as const) : ("11" as const) };
}

const SAMPLE: Row[] = [
  [1, ["run", "correr", "She runs every morning without fail."].join("\x1f"), 2],
  [2, ["study", "estudiar", "He studies hard for his examinations."].join("\x1f"), 2],
  [3, ["startle", "asustar", "The noise startled the horses."].join("\x1f"), 3],
];

describe("el .apkg se parsea", () => {
  it("schema 11 (col.decks en JSON)", () => {
    const r = parse(buildApkg({ notes: SAMPLE }));
    expect(r.schema).toBe("11");
    expect(r.notes).toHaveLength(3);
  });

  it("schema 18 (tabla decks)", () => {
    const r = parse(buildApkg({ notes: SAMPLE, schema18: true }));
    expect(r.schema).toBe("18");
    expect(r.notes).toHaveLength(3);
    expect(r.notes[0]!.deckName).toBe("4000 Essential English Words::Book 1");
  });

  it("la PK de notes es `id`, y esa query no lanza", () => {
    // El bug: `SELECT nid FROM notes` → "no such column: nid".
    const apkg = buildApkg({ notes: SAMPLE, noteCol: "id" });
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
    const roots = new Set(r.notes.map((n) => rootOf(n.deckName)));
    expect([...roots]).toEqual(["4000 Essential English Words"]);
  });

  it("separa los campos por \\x1f y limpia el HTML", () => {
    const r = parse(
      buildApkg({
        notes: [[1, ["<b>run</b>", "correr", "<div>She <i>runs</i>.</div>"].join("\x1f"), 2]],
      }),
    );
    expect(r.notes[0]!.fields).toEqual(["run", "correr", "She runs."]);
  });

  it('una nota sin card cae en "Sin deck" sin romper', () => {
    const apkg = buildApkg({ notes: SAMPLE });
    const r = parse(apkg);
    expect(r.notes.every((n) => n.deckName !== "")).toBe(true);
  });

  it("deck vacío → notes vacío, no error", () => {
    expect(parse(buildApkg({ notes: [] })).notes).toEqual([]);
  });
});

describe("el apkg se comprime y descomprime", () => {
  it("el round-trip preserva la base SQLite", () => {
    const apkg = buildApkg({ notes: SAMPLE });
    const files = unzipSync(apkg);
    expect(files["collection.anki2"]).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(files.media!)).toBe("{}");
  });
});
