import { packSave, unpackSave, type SaveGame, type SaveMeta } from './save';

/** Save slots in the browser's local storage (compressed). All calls tolerate blocked storage. */
const INDEX_KEY = 'trafficcity.saves';
const slotKey = (id: string): string => `trafficcity.save.${id}`;
export const AUTOSAVE_ID = 'autosave';

export function listSaves(): SaveMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const list = raw ? (JSON.parse(raw) as SaveMeta[]) : [];
    return list.filter((m) => localStorage.getItem(slotKey(m.id)) !== null).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

function writeIndex(list: SaveMeta[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list));
}

/** Stores a save; returns an error message or null. */
export async function storeSave(meta: SaveMeta, data: SaveGame): Promise<string | null> {
  try {
    const text = await packSave(data);
    localStorage.setItem(slotKey(meta.id), text);
    const list = listSaves().filter((m) => m.id !== meta.id);
    list.push(meta);
    writeIndex(list);
    return null;
  } catch (e) {
    return e instanceof DOMException && e.name === 'QuotaExceededError' ? 'Browser storage is full. Delete old saves or export this city to a file.' : 'Saving is not available in this browser';
  }
}

export async function readSave(id: string): Promise<SaveGame | null> {
  try {
    const text = localStorage.getItem(slotKey(id));
    return text ? await unpackSave(text) : null;
  } catch {
    return null;
  }
}

export function deleteSave(id: string): void {
  try {
    localStorage.removeItem(slotKey(id));
    writeIndex(listSaves().filter((m) => m.id !== id));
  } catch {
    // Storage blocked: nothing to delete.
  }
}

/** Player preferences. */
export interface Settings {
  autosave: boolean;
  despawnStuck: boolean;
  theme: 'auto' | 'light' | 'dark';
}

const SETTINGS_KEY = 'trafficcity.settings';
const DEFAULTS: Settings = { autosave: true, despawnStuck: true, theme: 'auto' };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function storeSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Settings only last for this session.
  }
}
