import { TILE, UNLOCK } from '../../config';
import type { Game } from '../../game/Game';
import { ROAD_TYPES } from '../../roads/roadTypes';
import { clear, h } from '../dom';
import { kvList, makePanel } from './panel';

const SPEEDS = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130];

/** Editable road panel: speed limit, truck ban, bus lanes and one-way direction. */
export function openSegmentPanel(game: Game, key: string): void {
  const world = game.world;
  if (!world) return;
  const handle = makePanel('Road', () => game.tools.inspect.select(null));
  const kv = kvList(['Type', 'Lanes', 'Length', 'Vehicles now', 'Average speed']);
  const controls = h('div');
  handle.body.append(kv.el, controls);
  const locked = (need: number): boolean => !world.sandbox && game.ui.population < need;

  const renderControls = (): void => {
    clear(controls);
    const seg = world.network.segByKey.get(key);
    if (!seg) return;
    const limit = Math.round(seg.speedLimit * 3.6);
    const sel = h('select', { class: 'input' }) as HTMLSelectElement;
    sel.append(h('option', { value: '0' }, `Default (${seg.type.speedKmh} km/h)`));
    for (const s of SPEEDS) sel.append(h('option', { value: String(s) }, `${s} km/h`));
    sel.value = limit === seg.type.speedKmh ? '0' : String(limit);
    sel.addEventListener('change', () => world.setSegmentAttrs(key, { speedKmh: Number(sel.value) }));
    controls.append(h('div', { class: 'section-title' }, 'Speed limit'), sel);

    const toggle = (label: string, on: boolean, need: number, title: string, fn: (v: boolean) => void): HTMLElement => {
      const lk = locked(need);
      const b = h('button', { class: 'btn small' + (on ? ' primary' : ''), type: 'button', title: lk ? `Unlocks at ${need.toLocaleString('en-US')} population` : title }, `${label}: ${on ? 'on' : 'off'}`);
      if (lk) b.classList.add('locked');
      b.addEventListener('click', () => {
        if (lk) {
          game.ui.toast(`Unlocks at ${need.toLocaleString('en-US')} population`, 'warn');
          return;
        }
        fn(!on);
      });
      return b;
    };
    const row = h('div', { class: 'row wrap' });
    row.append(toggle('Truck ban', seg.truckBan, UNLOCK.truckBan, 'Trucks only use this road to reach buildings on it', (v) => world.setSegmentAttrs(key, { truckBan: v })));
    if (seg.forward.length >= 2 || seg.backward.length >= 2) {
      row.append(toggle('Bus lane', seg.busLane, UNLOCK.busLane, 'The curb lane of each direction is reserved for buses', (v) => world.setSegmentAttrs(key, { busLane: v })));
    }
    if (seg.type.lanesB === 0) {
      const rev = h('button', { class: 'btn small', type: 'button' }, 'Reverse direction');
      rev.addEventListener('click', () => world.reverseOneWay(key));
      row.append(rev);
    }
    controls.append(h('div', { class: 'section-title' }, 'Rules'), row);
  };

  const refresh = (): void => {
    const seg = world.network.segByKey.get(key);
    if (!seg) {
      kv.set(['Removed', '-', '-', '-', '-']);
      return;
    }
    let n = 0;
    let sum = 0;
    for (const l of seg.lanes)
      for (const v of l.vehicles) {
        n++;
        sum += v.v;
      }
    kv.set([
      ROAD_TYPES[seg.type.id].name,
      seg.backward.length && seg.forward.length ? `${seg.forward.length} + ${seg.backward.length}` : `${seg.lanes.length} (one-way)`,
      `${Math.round(seg.length)} m (${(seg.length / TILE).toFixed(1)} tiles)`,
      String(n),
      n ? `${Math.round((sum / n) * 3.6)} km/h` : '-',
    ]);
  };
  renderControls();
  refresh();
  const timer = window.setInterval(refresh, 400);
  const off = world.events.on('network', () => {
    renderControls();
    refresh();
  });
  handle.el.addEventListener('closed', () => {
    window.clearInterval(timer);
    off();
  });
  game.ui.openPanel(handle.el, 'inspect');
}
