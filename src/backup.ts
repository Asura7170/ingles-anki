import { db, getSetting, setSetting, TABLES } from "./db";

/**
 * IndexedDB es best-effort LRU y "borrar datos de navegación" lo borra
 * SIEMPRE — `navigator.storage.persist()` no protege contra borrado explícito y
 * ninguna API web puede. El archivo en disco es el único red de seguridad real.
 */

const HANDLE_KEY = "backupHandle";
const DUMP_VERSION = 1;

export interface Dump {
  version: number;
  exportedAt: number;
  data: Record<string, unknown[]>;
}

interface FsaHandle extends FileSystemFileHandle {
  queryPermission(d?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(d?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}

type ShowSaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FsaHandle>;

const picker = (): ShowSaveFilePicker =>
  (window as unknown as { showSaveFilePicker: ShowSaveFilePicker }).showSaveFilePicker;

interface AnyTable {
  clear(): Promise<unknown>;
  toArray(): Promise<unknown[]>;
  bulkAdd(items: unknown[]): Promise<unknown>;
}

export async function buildDump(): Promise<Dump> {
  const tables = TABLES.map((t) => db[t] as unknown as AnyTable);
  const data: Record<string, unknown[]> = {};
  for (let i = 0; i < TABLES.length; i++) data[TABLES[i]!] = await tables[i]!.toArray();
  return { version: DUMP_VERSION, exportedAt: Date.now(), data };
}

export async function exportToDisk(): Promise<void> {
  const blob = new Blob([JSON.stringify(await buildDump())], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vocab-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importFromFile(file: File): Promise<void> {
  const parsed = JSON.parse(await file.text()) as Dump;
  if (parsed.version !== DUMP_VERSION) {
    throw new Error(`Versión de backup desconocida: ${parsed.version}`);
  }
  const tables = TABLES.map((t) => db[t] as unknown as AnyTable);
  await db.transaction("rw", db.tables, async () => {
    for (const t of tables) await t.clear();
    for (let i = 0; i < TABLES.length; i++) {
      const rows = parsed.data[TABLES[i]!];
      if (Array.isArray(rows) && rows.length) await tables[i]!.bulkAdd(rows);
    }
  });
}

/* ------------------------------------------------------------------ */
/* File System Access: auto-guardado                                    */
/* ------------------------------------------------------------------ */

async function askPermission(handle: FsaHandle): Promise<PermissionState> {
  if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return "granted";
  return handle.requestPermission({ mode: "readwrite" });
}

/** Sólo desde un gesto del usuario. Devuelve 'denied' si el usuario rechaza. */
export async function linkBackupFile(): Promise<PermissionState> {
  const handle = await picker()({
    suggestedName: "vocab-backup.json",
    types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
  });
  await setSetting(HANDLE_KEY, handle);
  return askPermission(handle);
}

/**
 * Re-autorizar tras una recarga: el permiso NO persiste entre sesiones y el
 * primer createWritable() tras recargar lanza NotAllowedError aunque el handle
 * sea válido.
 */
export async function regrantBackup(): Promise<PermissionState> {
  const handle = await getSetting<FsaHandle | null>(HANDLE_KEY, null);
  if (!handle) return "denied";
  return askPermission(handle);
}

/**
 * Guardado silencioso. NUNCA pide permiso (exige gesto del usuario) y NUNCA
 * borra la base si falla: degrada a export manual y avisa.
 */
export async function autoSave(): Promise<"written" | "degraded" | "absent"> {
  const handle = await getSetting<FsaHandle | null>(HANDLE_KEY, null);
  if (!handle) return "absent";
  try {
    if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") return "degraded";
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(await buildDump()));
    await writable.close();
    return "written";
  } catch {
    return "degraded";
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;

export function scheduleAutoSave(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void autoSave(), 2000);
}

export async function backupFileName(): Promise<string | null> {
  const handle = await getSetting<FsaHandle | null>(HANDLE_KEY, null);
  return handle?.name ?? null;
}
