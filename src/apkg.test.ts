import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { IDBFactory } from "fake-indexeddb";
import { zipSync } from "fflate";
import initSqlJs from "sql.js";
import { db } from "./db";
import { importApkg } from "./apkg";
import { parseApkgBytes } from "./apkg-parse";

/**
 * `importApkg` de verdad, sin Worker real: el seam `parse` inyecta
 * `parseApkgBytes`, que es la misma función que el worker ejecuta. Lo que no
 * se prueba es el transporte (`postMessage`, temporizador) — andamiaje, no
 * lógica — y happy-dom ni Node exponen `Worker` para probarlo.
 *
 * El otro `it` fija el contrato del mensaje: el worker devuelve `ApkgOut` con
 * `postMessage` SIN transfer list, o sea `structuredClone`. Si `media` no
 * sobrevive al clon, las imágenes mueren entre el worker y el hilo principal
 * sin que ningún lado falle.
 */

const SQL = await initSqlJs({
  wasmBinary: await (async () => {
    const { readFileSync } = await import("node:fs");
    const buf = readFileSync("./node_modules/sql.js/dist/sql-wasm.wasm");
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  })(),
});

const CAT = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** .apkg mínimo con 3 notas: una con imagen buena, una sin imagen, una rota. */
function buildApkg(): Uint8Array {
  const db = new SQL.Database();
  db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT)`);
  db.run(
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, nid INTEGER, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld INTEGER, csum INTEGER, flags INTEGER, data TEXT)`,
  );
  db.run(
    `CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, mod INTEGER, type INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)`,
  );
  db.run(`INSERT INTO col VALUES (1, '{}', ?)`, [
    JSON.stringify({ 2: { name: "4000 Essential English Words::Book 1" } }),
  ]);

  const notes: [number, string][] = [
    [1, ['run <img src="cat.jpg">', "correr", "She runs every morning without fail."].join("\x1f")],
    [2, ["study", "estudiar", "He studies hard for his examinations."].join("\x1f")],
    [
      3,
      ['startle <img src="fantasma.jpg">', "asustar", "The noise startled the horses."].join(
        "\x1f",
      ),
    ],
  ];
  for (const [nid, flds] of notes) {
    db.run(`INSERT INTO notes (id, nid, mid, mod, usn, tags, flds) VALUES (?,?,1,0,0,'',?)`, [
      nid,
      nid,
      flds,
    ]);
    db.run(`INSERT INTO cards (id, nid, did, ord) VALUES (?,?,2,0)`, [nid, nid]);
  }

  const exported = new Uint8Array(db.export());
  db.close();
  return zipSync({
    "collection.anki2": exported,
    media: new TextEncoder().encode('{"0":"cat.jpg"}'),
    "0": CAT,
  });
}

const asFile = (zip: Uint8Array) =>
  new File(
    [zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer],
    "m.apkg",
  );

/** Lo que el worker hace: parsear fuera del hilo principal. */
const direct = (buffer: ArrayBuffer) => Promise.resolve(parseApkgBytes(buffer, SQL));

/** .apkg mínimo con las notas dadas (campos ya unidos por \x1f), sin media. */
function buildNotesApkg(deck: string, fldsList: string[]): Uint8Array {
  const dbh = new SQL.Database();
  dbh.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT)`);
  dbh.run(
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, nid INTEGER, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld INTEGER, csum INTEGER, flags INTEGER, data TEXT)`,
  );
  dbh.run(
    `CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, mod INTEGER, type INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)`,
  );
  dbh.run(`INSERT INTO col VALUES (1, '{}', ?)`, [JSON.stringify({ 2: { name: deck } })]);
  fldsList.forEach((flds, i) => {
    const nid = i + 1;
    dbh.run(`INSERT INTO notes (id, nid, mid, mod, usn, tags, flds) VALUES (?,?,1,0,0,'',?)`, [
      nid,
      nid,
      flds,
    ]);
    dbh.run(`INSERT INTO cards (id, nid, did, ord) VALUES (?,?,2,0)`, [nid, nid]);
  });
  const zip = zipSync({
    "collection.anki2": new Uint8Array(dbh.export()),
    media: new TextEncoder().encode("{}"),
  });
  dbh.close();
  return zip;
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await db.delete();
  await db.open();
});

afterEach(() => {
  db.close();
});

describe("importApkg sin worker", () => {
  it("crea el mazo, las palabras y vuelca la imagen; la rota se cuenta", async () => {
    const r = await importApkg(asFile(buildApkg()), direct);

    expect(r.deckName).toBe("4000 Essential English Words");
    expect(r.result.created).toBe(3);
    expect(r.skipped).toBe(0);
    // `fantasma.jpg` está en el campo pero no en el zip: la palabra entra
    // igual y la ausencia se cuenta, no se lanza.
    expect(r.skippedImages).toBe(1);

    const run = (await db.nodes.where("lemma").equals("run").first())!;
    const rows = await db.media.where("nodeId").equals(run.id!).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("cat.jpg");
    expect(rows[0]!.bytes).toEqual(CAT);

    const plain = (await db.nodes.where("lemma").equals("study").first())!;
    expect(await db.media.where("nodeId").equals(plain.id!).count()).toBe(0);
  });

  it("campo-código primero: la palabra es el campo 1, no el ID", async () => {
    // Mazos como "1000 Basic English Words" traen un ID en el campo 0
    // ("1000BEW_B01_U01_001") y la palabra en el 1. Sin el salto, el ID
    // acababa de lemma y el mazo entero era basura.
    const dbh = new SQL.Database();
    dbh.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT)`);
    dbh.run(
      `CREATE TABLE notes (id INTEGER PRIMARY KEY, nid INTEGER, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld INTEGER, csum INTEGER, flags INTEGER, data TEXT)`,
    );
    dbh.run(
      `CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, mod INTEGER, type INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)`,
    );
    dbh.run(`INSERT INTO col VALUES (1, '{}', ?)`, [
      JSON.stringify({ 2: { name: "1000 Basic English Words" } }),
    ]);
    const flds = [
      "1000BEW_B01_U01_001",
      "cry",
      "krái",
      "verb",
      "to show sadness",
      "He cries when he is sad.",
    ].join("\x1f");
    dbh.run(`INSERT INTO notes (id, nid, mid, mod, usn, tags, flds) VALUES (1,1,1,0,0,'',?)`, [
      flds,
    ]);
    dbh.run(`INSERT INTO cards (id, nid, did, ord) VALUES (1,1,2,0)`);
    const zip = zipSync({
      "collection.anki2": new Uint8Array(dbh.export()),
      media: new TextEncoder().encode("{}"),
    });
    dbh.close();

    const r = await importApkg(asFile(zip), direct);
    expect(r.deckName).toBe("1000 Basic English Words");
    expect(r.result.created).toBe(1);
    expect(await db.nodes.where("lemma").equals("cry").first()).toBeTruthy();
    // El código no crea nodo: un solo lemma en la base.
    expect(await db.nodes.count()).toBe(1);
  });

  it("la definición larga no roba el ejemplo: gana donde aparece la palabra", async () => {
    // "to make a car move" (5 palabras) es más larga que "He drives to work."
    // (4). Con "más largo" de ejemplo, la card caía a rama word-only aunque la
    // frase estaba en el mazo.
    const r = await importApkg(
      asFile(
        buildNotesApkg("1000 Basic English Words", [
          [
            "DRV_01",
            "drive",
            "dráiv",
            "verb",
            "to make a car move",
            "He drives to work.",
            "drives",
          ].join("\x1f"),
        ]),
      ),
      direct,
    );
    expect(r.result.created).toBe(1);
    const drive = (await db.nodes.where("lemma").equals("drive").first())!;
    const ex = await db.examples.where("nodeId").equals(drive.id!).toArray();
    expect(ex.map((e) => e.text)).toEqual(["He drives to work."]);
  });

  it("stopwords y muletillas entran igual: en un .apkg todo es vocabulario", async () => {
    // have/like/think/know/ill los mataban FILLERS/STOPWORDS (pensados para
    // transcripciones) y la nota se saltaba entera.
    const r = await importApkg(
      asFile(
        buildNotesApkg("1000 Basic English Words", [
          ["have", "hǽv", "verb", "to own", "They have a car.", "have"].join("\x1f"),
          ["like", "láik", "verb", "to enjoy", "She likes tea.", "likes"].join("\x1f"),
          ["ill", "íl", "adjective", "not well", "He is ill.", "ill"].join("\x1f"),
        ]),
      ),
      direct,
    );
    expect(r.result.created).toBe(3);
    expect(r.skipped).toBe(0);
    for (const lemma of ["have", "like", "ill"]) {
      expect(await db.nodes.where("lemma").equals(lemma).first()).toBeTruthy();
    }
  });
});

describe("contrato del mensaje worker → main", () => {
  it("media sobrevive a structuredClone, que es lo que hace postMessage sin transfer", () => {
    const zip = buildApkg();
    const out = parseApkgBytes(
      zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer,
      SQL,
    );
    if (!out.ok) throw new Error(out.error);

    const back = structuredClone(out);
    expect(back.notes[0]!.images).toEqual(["cat.jpg"]);
    expect(back.media["cat.jpg"]).toEqual(CAT);
    expect(back.media["cat.jpg"]).toBeInstanceOf(Uint8Array);
  });
});
