import { describe, expect, it } from "vite-plus/test";
import { unzipSync, zipSync } from "fflate";
import initSqlJs from "sql.js";
import { rootOf } from "./apkg-format";
import { parseApkgBytes } from "./apkg-parse";

const hexToBytes = (hex: string) =>
  new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

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
  /**
   * `true` = layout v3 (Anki 23.10+): la real es `collection.anki21b`, y el
   * exportador escribe además un `collection.anki2` DUMMY. Por defecto legacy:
   * la real es `collection.anki2`.
   */
  v3?: boolean;
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
  const exported = new Uint8Array(db.export());
  db.close();

  if (!opts.v3) {
    return zipSync({ "collection.anki2": exported, media: new TextEncoder().encode("{}") });
  }

  // Layout v3: la real es anki21b y el anki2 es un dummy con una sola nota que
  // dice "This file requires a newer version of Anki." — igual que hace
  // `write_dummy_collection` en el exportador de Anki.
  const dummy = new SQL.Database();
  dummy.run(
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, nid INTEGER, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld INTEGER, csum INTEGER, flags INTEGER, data TEXT)`,
  );
  dummy.run(`INSERT INTO notes (id, nid, mid, mod, usn, tags, flds) VALUES (1,1,1,0,0,'',?)`, [
    ["", "This file requires a newer version of Anki."].join("\x1f"),
  ]);
  const dummyBytes = new Uint8Array(dummy.export());
  dummy.close();

  return zipSync({
    meta: new Uint8Array([0x08, 0x03]), // PackageMetadata{ version: 3 }
    "collection.anki21b": exported,
    "collection.anki2": dummyBytes,
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

  // --- media ---------------------------------------------------------------
  //
  // El mapa `media` es índice-en-zip → nombre. Las entradas del zip se llaman
  // SIEMPRE por índice, nunca por nombre, así que el nombre real hay que
  // resolverlo por el mapa.
  const CAT = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // cabecera PNG
  const DOG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x42]);

  /**
   * `MediaEntries{ entries: [MediaEntry{name,size,sha1}, …] }` en hexadecimal.
   * Un `repeated` en protobuf son N campos sueltos con la misma etiqueta, NO
   * un envoltorio único: cada entrada lleva su propio tag+longitud. Dos
   * entradas a propósito, y la segunda con un espacio en el nombre, que es
   * justo el caso que rompía el folklore del percent-encoding.
   */
  // Cada entrada: tag exterior 0x0a + longitud del entry entero + entry.
  // Sin ese envoltorio el parser lee el tag del `name` como si fuese el del
  // entry y el mapa sale vacío — que es exactamente lo que pasó al escribir
  // este fixture la primera vez.
  const PROTO = hexToBytes(
    "0a22" +
      "0a07" +
      "6361742e6a7067" +
      "10e20a" +
      "1a14" +
      "01".repeat(20) +
      "0a2b" +
      "0a10" +
      "646f6720616e6420626f6e652e706e67" +
      "108010" +
      "1a14" +
      "02".repeat(20),
  );

  /**
   * Envoltura zstd mínima, hecha a mano porque `fzstd` sólo descomprime.
   * Magic + descriptor (single-segment, FCS de 4 bytes) + tamaño + un bloque
   * RAW con Last_Block=1. Es el mismo formato que emite el exportador de Anki.
   */
  const zstdRaw = (payload: Uint8Array): Uint8Array => {
    const n = payload.length;
    // magic(4) + descriptor(1) + FCS(4) + Block_Header(3).
    const header = new Uint8Array(12);
    header.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0], 0);
    new DataView(header.buffer).setUint32(5, n, true);
    const bh = (n << 3) | 1; // Last_Block=1, tipo 0 (RAW), tamaño
    header[9] = bh & 0xff;
    header[10] = (bh >>> 8) & 0xff;
    header[11] = (bh >>> 16) & 0xff;
    return new Uint8Array([...header, ...payload]);
  };

  /** Re-empaqueta el mapa y las entradas de media como los escribe Anki. */
  function withMedia(
    opts: Parameters<typeof buildApkg>[0],
    media: { map: Uint8Array; files: Record<string, Uint8Array> },
  ): Uint8Array {
    return zipSync({ ...unzipSync(buildApkg(opts)), media: media.map, ...media.files });
  }

  it("legacy: resuelve <img> a su entrada del zip por el mapa media", () => {
    const r = parse(
      withMedia(
        { notes: [[1, ['<img src="cat.jpg">', "gato", "The cat sleeps."].join("\x1f"), 2]] },
        {
          map: new TextEncoder().encode('{"0":"cat.jpg","1":"dog and bone.png"}'),
          files: { "0": CAT, "1": DOG },
        },
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.notes[0]!.images).toEqual(["cat.jpg"]);
    // El nombre del zip es el índice; `media` es quien traduce.
    expect(r.media["cat.jpg"]).toEqual(CAT);
    expect(r.media["dog and bone.png"]).toEqual(DOG);
    // Y el texto sigue limpio: la imagen se extrae aparte, no ensucia el campo.
    expect(r.notes[0]!.fields[0]).toBe("");
  });

  it("v3: el mapa media es zstd+protobuf, no JSON", () => {
    const r = parse(
      withMedia(
        {
          notes: [[1, ['<img src="cat.jpg">', "gato", "The cat sleeps."].join("\x1f"), 2]],
          v3: true,
        },
        { map: zstdRaw(PROTO), files: { "0": CAT, "1": DOG } },
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.notes[0]!.images).toEqual(["cat.jpg"]);
    // Orden del vector = índice, sin campo índice: la segunda entrada es el "1".
    expect(r.media["cat.jpg"]).toEqual(CAT);
    expect(r.media["dog and bone.png"]).toEqual(DOG);
  });

  it("recoge el <img> de todos los campos, no sólo del ejemplo", () => {
    // La imagen es de la palabra, no de la frase. Y si el texto de la frase
    // llevara el <img>, `blankSentence` trocearía por espacios y `identify`
    // devolvería null en "<img": el clo se rompería. Por eso se extrae antes
    // de stripHtml y en todos los campos.
    const r = parse(
      withMedia(
        {
          notes: [
            [1, ['<img src="cat.jpg">', "gato", 'A <img src="cat.jpg"> sleeps.'].join("\x1f"), 2],
          ],
        },
        { map: new TextEncoder().encode('{"0":"cat.jpg"}'), files: { "0": CAT } },
      ),
    );
    expect(r.notes[0]!.images).toEqual(["cat.jpg"]); // dedup, no dos veces
    expect(r.notes[0]!.fields[2]).toBe("A sleeps.");
  });

  it("sin fichero media no es error: se importa sin imágenes", () => {
    const r = parse(
      zipSync({ "collection.anki2": unzipSync(buildApkg({ notes: SAMPLE }))["collection.anki2"]! }),
    );
    expect(r.ok).toBe(true);
    expect(r.notes).toHaveLength(3);
    expect(r.media).toEqual({});
  });

  it("<img> que el mapa no resuelve se degrada sin romper la importación", () => {
    const r = parse(
      withMedia(
        { notes: [[1, ['<img src="fantasma.jpg">', "gato", "The cat sleeps."].join("\x1f"), 2]] },
        { map: new TextEncoder().encode('{"0":"cat.jpg"}'), files: { "0": CAT } },
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.notes).toHaveLength(1);
    expect(r.media["fantasma.jpg"]).toBeUndefined();
  });

  it("una entrada del zip que el mapa nombra pero no existe se salta", () => {
    const r = parse(
      withMedia(
        { notes: SAMPLE },
        { map: new TextEncoder().encode('{"0":"cat.jpg","7":"hole.png"}'), files: { "0": CAT } },
      ),
    );
    expect(r.ok).toBe(true);
    expect(Object.keys(r.media)).toEqual(["cat.jpg"]);
  });

  it("un mapa media corrupto deja el mazo entero importable", () => {
    const r = parse(
      withMedia({ notes: SAMPLE }, { map: new TextEncoder().encode("esto no es json"), files: {} }),
    );
    expect(r.ok).toBe(true);
    expect(r.notes).toHaveLength(3);
    expect(r.media).toEqual({});
  });

  it("un mapa media v3 truncado a medias se lee hasta donde llega", () => {
    const r = parse(
      withMedia(
        { notes: SAMPLE, v3: true },
        // Se corta justo después del tag de la segunda entrada (byte 36),
        // dejando su longitud a medias: la primera entra, la segunda se
        // pierde. Cortar la cola de un VALOR no bastaría —los campos
        // len-delimited se autodelimitan y el nombre ya se habría leído—,
        // así que el corte va en el prefijo. Un mapa a medias no puede
        // tumbar la importación.
        { map: zstdRaw(PROTO.subarray(0, 37)), files: { "0": CAT, "1": DOG } },
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.notes).toHaveLength(3);
    expect(Object.keys(r.media)).toEqual(["cat.jpg"]);
  });

  it("deck vacío → notes vacío, no error", () => {
    expect(parse(buildApkg({ notes: [] })).notes).toEqual([]);
  });

  // El bug. `DB_FILES` buscaba `collection.anki2` primero, y en un .apkg moderno
  // ese nombre es el DUMMY que escribe el exportador: el mazo entero se
  // importaba como una nota que dice "This file requires a newer version of
  // Anki.". Un .apkg real habría delatado el orden; el fixture no lo tenía.
  it("layout v3: lee anki21b, no el collection.anki2 dummy", () => {
    const r = parse(buildApkg({ notes: SAMPLE, v3: true }));
    expect(r.notes).toHaveLength(3);
    expect(r.notes.map((n) => n.fields[0])).toEqual(["run", "study", "startle"]);
    expect(r.notes.some((n) => n.fields.some((f) => f.includes("newer version")))).toBe(false);
  });

  it("layout v3 sin anki21b legible: el dummy no enmascara el error", () => {
    // Sin la real, importa el dummy y no finge que el mazo está vacío.
    const r = parse(buildApkg({ notes: SAMPLE, v3: true }));
    expect(r.ok).toBe(true);
    // Legacy sin ninguna base: el mensaje sigue nombrando lo que falta.
    expect(() => parse(zipSync({ media: new TextEncoder().encode("{}") }))).toThrow(
      /collection\.anki2/,
    );
  });
});

describe("el apkg se comprime y descomprime", () => {
  it("el round-trip preserva la base SQLite", () => {
    const files = unzipSync(buildApkg({ notes: SAMPLE }));
    expect(files["collection.anki2"]).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(files.media!)).toBe("{}");
  });
});
