import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IDBFactory } from "fake-indexeddb";
import { db } from "./db";
import { resolveImages } from "./apkg";
import { buildDump, importFromFile } from "./backup";
import { ingest } from "./ingest";

/**
 * Lo único que el backup hace con `media` y que ningún otro test cubre:
 * `Uint8Array` no sobrevive a `JSON.stringify` tal cual, así que la tabla
 * `media` pasa por base64 al exportar y vuelve a bytes al importar. Si esa
 * conversión se rompe, las imágenes se pierden en silencio en el próximo
 * autosave — y el backup es el único red real.
 */

const NOW = Date.UTC(2026, 0, 15);
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 1, 2]);

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await db.delete();
  await db.open();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

async function seedMedia() {
  await ingest(
    [
      {
        headword: "run",
        lemma: "run",
        kind: "word",
        translations: ["correr"],
        images: [{ name: "run.jpg", mime: "image/jpeg", bytes: BYTES }],
      },
    ],
    { kind: "apkg", priority: 30, deckId: 1, noteId: 1 },
  );
}

describe("backup con imágenes", () => {
  it("el dump guarda los bytes como base64, no como objeto", async () => {
    await seedMedia();
    const dump = await buildDump();
    const rows = dump.data.media as { bytes: unknown }[];
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!.bytes).toBe("string");
    // Y sobrevive al JSON de verdad: es lo que viaja al disco.
    const back = JSON.parse(JSON.stringify(dump));
    expect(typeof back.data.media[0].bytes).toBe("string");
  });

  it("exportar e importar devuelve los bytes intactos", async () => {
    await seedMedia();
    const json = JSON.stringify(await buildDump());
    await db.nodes.clear();
    await db.media.clear();
    await importFromFile(new File([json], "b.json", { type: "application/json" }));

    const rows = await db.media.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("run.jpg");
    expect(rows[0]!.mime).toBe("image/jpeg");
    expect(rows[0]!.bytes).toEqual(BYTES);
    expect(rows[0]!.bytes).toBeInstanceOf(Uint8Array);
  });

  it("un backup v1 sin `media` restaura entero: la clave es opcional", async () => {
    // Por eso `DUMP_VERSION` no sube: subirla convertiría todo backup
    // existente en "Versión de backup desconocida".
    await seedMedia();
    const dump = await buildDump();
    delete dump.data.media;
    await db.nodes.clear();
    await db.media.clear();
    await importFromFile(new File([JSON.stringify(dump)], "v1.json", { type: "application/json" }));

    expect(await db.nodes.count()).toBe(1);
    expect(await db.media.count()).toBe(0);
  });
});

describe("resolveImages", () => {
  const CAT = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const media = { "cat.jpg": CAT };

  it("resuelve nombre a bytes con su mime", () => {
    const r = resolveImages(["cat.jpg"], media);
    expect(r.skipped).toBe(0);
    expect(r.images).toEqual([{ name: "cat.jpg", mime: "image/jpeg", bytes: CAT }]);
  });

  it("rota, enorme o sin mime: se cuenta y la palabra entra igual", () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const r = resolveImages(["fantasma.jpg", "grande.png", "sonido.mp3"], {
      "grande.png": big,
      "sonido.mp3": new Uint8Array([1]),
    });
    expect(r.images).toEqual([]);
    expect(r.skipped).toBe(3);
  });

  it("mezcla: las buenas pasan y las malas se cuentan", () => {
    const r = resolveImages(["cat.jpg", "fantasma.jpg"], media);
    expect(r.images).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });

  it("sin nombres no hay nada que resolver", () => {
    expect(resolveImages([], media)).toEqual({ images: [], skipped: 0 });
  });
});
