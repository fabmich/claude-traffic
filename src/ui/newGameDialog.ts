import { MAP_SIZES, type MapSizeKey } from '../config';
import { randomSeed } from '../core/rng';
import type { NewGameOptions } from '../game/World';
import { TerrainColors } from '../render/terrainDraw';
import { generateMap } from '../world/mapgen';
import { h, icon } from './dom';
import { ICONS } from './icons';
import { randomCityName } from './names';

/** Modal dialog to configure and start a new city, with a live terrain preview. */
export function createNewGameDialog(onStart: (o: NewGameOptions) => void, onCancel: (() => void) | null, extraActions: HTMLElement[] = []): HTMLElement {
  let seed = randomSeed();
  let sizeKey: MapSizeKey = 'medium';
  let sandbox = false;

  const nameInput = h('input', { type: 'text', value: randomCityName(), maxLength: 28, class: 'input' });
  const seedInput = h('input', { type: 'number', value: String(seed), class: 'input seed' });
  const preview = h('canvas', { class: 'preview', width: 256, height: 256 });
  const legend = h(
    'div',
    { class: 'legend' },
    ...[
      ['#b2d696', 'Grass'],
      ['#a0cb88', 'Forest'],
      ['#d6cc80', 'Farmland'],
      ['#c0b2d2', 'Rich ground'],
      ['#b2aa9e', 'Mountain'],
      ['#8cc5e8', 'Water'],
      ['#e05050', 'Highway exit'],
    ].map(([c, n]) => h('span', { class: 'legend-item' }, h('i', { style: { background: c } }), n)),
  );

  let timer = 0;
  const redraw = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const size = MAP_SIZES[sizeKey];
      const map = generateMap({ seed, size });
      const colors = new TerrainColors(map);
      const ctx = preview.getContext('2d')!;
      const px = 256 / size;
      ctx.clearRect(0, 0, 256, 256);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          ctx.fillStyle = colors.colors[y * size + x];
          ctx.fillRect(Math.floor(x * px), Math.floor(y * px), Math.ceil(px), Math.ceil(px));
        }
      }
      ctx.fillStyle = '#e05050';
      for (const oc of map.outside) {
        ctx.beginPath();
        ctx.arc((oc.x + 0.5) * px, (oc.y + 0.5) * px, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }, 60);
  };

  seedInput.addEventListener('input', () => {
    seed = Math.abs(Math.floor(Number(seedInput.value) || 0));
    redraw();
  });

  const sizeButtons = (Object.keys(MAP_SIZES) as MapSizeKey[]).map((k) => {
    const b = h('button', { class: 'seg' + (k === sizeKey ? ' active' : ''), type: 'button' }, `${k[0].toUpperCase()}${k.slice(1)} (${MAP_SIZES[k]}²)`);
    b.addEventListener('click', () => {
      sizeKey = k;
      sizeButtons.forEach((sb) => sb.classList.toggle('active', sb === b));
      redraw();
    });
    return b;
  });

  const modeButtons = [
    ['Normal', false, 'Budget and milestone unlocks'],
    ['Sandbox', true, 'Unlimited money, everything unlocked'],
  ].map(([label, value, title]) => {
    const b = h('button', { class: 'seg' + (value === sandbox ? ' active' : ''), type: 'button', title: String(title) }, String(label));
    b.addEventListener('click', () => {
      sandbox = value as boolean;
      modeButtons.forEach((mb) => mb.classList.toggle('active', mb === b));
    });
    return b;
  });

  const dice = h('button', { class: 'icon-btn', type: 'button', title: 'Random seed' }, icon(ICONS.dice));
  dice.addEventListener('click', () => {
    seed = randomSeed();
    seedInput.value = String(seed);
    redraw();
  });

  const start = h('button', { class: 'btn primary', type: 'button' }, 'Start building');
  start.addEventListener('click', () => {
    onStart({ seed, size: MAP_SIZES[sizeKey], cityName: nameInput.value.trim() || 'New City', sandbox });
  });

  const cancel = onCancel ? h('button', { class: 'btn', type: 'button', onclick: onCancel }, 'Cancel') : null;

  const dialog = h(
    'div',
    { class: 'modal-backdrop' },
    h(
      'div',
      { class: 'modal new-game' },
      h('h2', null, 'New city'),
      h(
        'div',
        { class: 'ng-body' },
        h(
          'div',
          { class: 'ng-form' },
          h('label', null, 'City name', nameInput),
          h('label', null, 'Map seed', h('div', { class: 'row' }, seedInput, dice)),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Map size'), h('div', { class: 'segmented' }, ...sizeButtons)),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Mode'), h('div', { class: 'segmented' }, ...modeButtons)),
          h(
            'p',
            { class: 'hint' },
            'Connect roads to a highway exit (red), zone land, and keep the traffic flowing as your city grows.',
          ),
        ),
        h('div', { class: 'ng-preview' }, preview, legend),
      ),
      h('div', { class: 'modal-actions' }, ...extraActions, extraActions.length ? h('span', { class: 'spacer' }) : null, cancel, start),
    ),
  );
  redraw();
  return dialog;
}
