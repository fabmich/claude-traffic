import { formatInt, formatMoney } from '../core/math';
import type { Game } from '../game/Game';
import type { SaveGame } from '../game/save';
import { AUTOSAVE_ID, deleteSave, listSaves, type Settings } from '../game/storage';
import { h } from './dom';

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

/** Opens a file picker and loads the chosen save file. */
function importFile(game: Game): void {
  const input = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as SaveGame;
      game.loadGame(data);
      game.ui.closeModal();
      game.ui.toast(`Loaded ${data.options.cityName}`, 'good');
    } catch (e) {
      game.ui.toast(e instanceof Error && !(e instanceof SyntaxError) ? e.message : 'This file is not a Traffic City save', 'warn');
    }
  });
  input.click();
}

function exportFile(game: Game): void {
  const data = game.snapshot();
  if (!data) return;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${game.saveId}.trafficcity.json` });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** List of saved cities with load and delete buttons. `back` replaces closing (used before any city exists). */
export function showLoadDialog(game: Game, back?: () => void): void {
  const ui = game.ui;
  const list = h('div', { class: 'save-list' });
  const render = (): void => {
    const saves = listSaves();
    if (saves.length === 0) {
      list.replaceChildren(h('p', { class: 'hint' }, 'No saved cities yet. Cities are saved automatically every two minutes, or from the menu.'));
      return;
    }
    list.replaceChildren(
      ...saves.map((m) => {
        const load = h('button', { class: 'btn small primary', type: 'button' }, 'Load');
        load.addEventListener('click', async () => {
          if (await game.loadSaved(m.id)) {
            ui.closeModal();
            ui.toast(`Loaded ${m.name}`, 'good');
          }
        });
        const del = h('button', { class: 'btn small danger', type: 'button' }, 'Delete');
        del.addEventListener('click', () => {
          deleteSave(m.id);
          render();
        });
        return h(
          'div',
          { class: 'save-row' },
          h(
            'div',
            { class: 'save-info' },
            h('b', null, m.id === AUTOSAVE_ID ? `${m.name} (autosave)` : m.name),
            h('span', null, `Day ${m.day} · ${formatInt(m.population)} residents · ${m.sandbox ? 'sandbox' : formatMoney(m.money)} · ${ago(m.savedAt)}`),
          ),
          load,
          del,
        );
      }),
    );
  };
  render();
  const importBtn = h('button', { class: 'btn', type: 'button' }, 'Import file…');
  importBtn.addEventListener('click', () => importFile(game));
  const dlg = h(
    'div',
    { class: 'modal-backdrop' },
    h(
      'div',
      { class: 'modal load-dialog' },
      h('h2', null, 'Load city'),
      list,
      h('div', { class: 'modal-actions' }, importBtn, h('button', { class: 'btn', type: 'button', onclick: () => (back ? back() : ui.closeModal()) }, back ? 'Back' : 'Close')),
    ),
  );
  ui.showModal(dlg, !back);
}

function showSettings(game: Game): void {
  const ui = game.ui;
  const s: Settings = { ...game.settings };
  const check = (label: string, key: 'autosave' | 'despawnStuck', hint: string): HTMLElement => {
    const box = h('input', { type: 'checkbox', checked: s[key] }) as HTMLInputElement;
    box.addEventListener('change', () => {
      s[key] = box.checked;
      game.applySettings({ ...s });
    });
    return h('label', { class: 'setting' }, box, h('span', null, h('b', null, label), h('small', null, hint)));
  };
  const themes = (['auto', 'light', 'dark'] as const).map((t) => {
    const b = h('button', { class: `seg${s.theme === t ? ' active' : ''}`, type: 'button' }, t === 'auto' ? 'System' : t === 'light' ? 'Light' : 'Dark');
    b.addEventListener('click', () => {
      s.theme = t;
      themes.forEach((x) => x.classList.toggle('active', x === b));
      game.applySettings({ ...s });
    });
    return b;
  });
  const dlg = h(
    'div',
    { class: 'modal-backdrop' },
    h(
      'div',
      { class: 'modal settings' },
      h('h2', null, 'Settings'),
      check('Autosave', 'autosave', 'Save the city in this browser every two minutes'),
      check('Remove stuck vehicles', 'despawnStuck', 'Vehicles waiting more than 3 minutes disappear, so a jam cannot freeze the city'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Panel theme'), h('div', { class: 'segmented' }, ...themes)),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => ui.closeModal() }, 'Done')),
    ),
  );
  ui.showModal(dlg, true);
}

/** Save, load, export, import and settings entries of the main menu. */
export function setupSaveUI(game: Game): void {
  const ui = game.ui;
  ui.menuExtras.push(
    {
      label: 'Save city',
      fn: async () => {
        const err = await game.saveGame();
        ui.toast(err ?? 'City saved', err ? 'warn' : 'good');
      },
    },
    { label: 'Load city…', fn: () => showLoadDialog(game) },
    { label: 'Export save file', fn: () => exportFile(game) },
    { label: 'Import save file…', fn: () => importFile(game) },
    { label: 'Settings…', fn: () => showSettings(game) },
  );
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && game.world) {
      e.preventDefault();
      void game.saveGame().then((err) => ui.toast(err ?? 'City saved', err ? 'warn' : 'good'));
    }
  });
}
