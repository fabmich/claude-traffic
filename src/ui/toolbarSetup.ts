import { formatMoney } from '../core/math';
import type { Game } from '../game/Game';
import { BulldozeTool } from '../input/tools/BulldozeTool';
import { RoadTool } from '../input/tools/RoadTool';
import { LANE_W } from '../config';
import { ROAD_TYPES, roadWidth, type RoadType } from '../roads/roadTypes';
import { clear, h, icon } from './dom';
import { ICONS } from './icons';

/** Small SVG preview of a road type's cross-section. */
function roadSwatch(t: RoadType): string {
  const w = roadWidth(t);
  const scale = 26 / 24;
  const total = w * scale;
  const x0 = (28 - total) / 2;
  let body = `<rect x="${x0}" y="2" width="${total}" height="20" rx="2" fill="${t.edgeColor}"/>`;
  const inner = (w - (t.highway ? 0 : 2 * t.shoulder)) * scale;
  body += `<rect x="${(28 - inner) / 2}" y="2" width="${inner}" height="20" fill="${t.asphalt}"/>`;
  if (t.median > 0) body += `<rect x="${14 - (t.median * scale) / 2}" y="2" width="${t.median * scale}" height="20" fill="${t.medianColor}"/>`;
  const lanes = t.lanesF + t.lanesB;
  const lanesW = lanes * LANE_W * scale + t.median * scale;
  let x = 14 - lanesW / 2;
  for (let i = 0; i < lanes; i++) {
    const cx = x + (LANE_W * scale) / 2;
    const up = i >= t.lanesB;
    body += up ? `<path d="M${cx} 8l-1.6 3h3.2z" fill="#fff"/>` : `<path d="M${cx} 16l-1.6 -3h3.2z" fill="#fff"/>`;
    x += LANE_W * scale;
    if (i === t.lanesB - 1 && t.median > 0) x += t.median * scale;
  }
  return `<svg viewBox="0 0 28 24" width="28" height="24">${body}</svg>`;
}

export function isRoadUnlocked(game: Game, t: RoadType): boolean {
  const world = game.world;
  if (!world || world.sandbox) return true;
  return game.ui.population >= t.unlockPop;
}

/** Registers the main toolbar tools. Later phases add more groups. */
export function setupToolbar(game: Game): { road: RoadTool; bulldoze: BulldozeTool } {
  const ui = game.ui;
  const road = new RoadTool(game);
  const bulldoze = new BulldozeTool(game);

  const showRoadTypes = (): void => {
    const host = ui.subToolbar;
    clear(host);
    for (const t of ROAD_TYPES) {
      if (t.id === 0) continue;
      const btn = h(
        'button',
        { class: 'tool-btn', type: 'button', title: `${t.name}: ${t.description} (${t.speedKmh} km/h)` },
        h('span', { class: 'swatch', html: roadSwatch(t) }),
        h('span', { class: 'tool-label' }, t.name),
        h('span', { class: 'tool-cost' }, isRoadUnlocked(game, t) ? `${formatMoney(t.cost)}/tile` : `🔒 ${t.unlockPop.toLocaleString('en-US')} pop`),
      );
      btn.classList.toggle('active', road.typeId === t.id);
      btn.classList.toggle('locked', !isRoadUnlocked(game, t));
      btn.addEventListener('click', () => {
        if (!isRoadUnlocked(game, t)) {
          ui.toast(`${t.name} unlocks at ${t.unlockPop.toLocaleString('en-US')} population`, 'warn');
          return;
        }
        road.typeId = t.id;
        showRoadTypes();
      });
      host.append(btn);
    }
    const over = h(
      'button',
      { class: 'tool-btn' + (road.overpass ? ' active' : ''), type: 'button', title: 'Overpass: build a straight bridge over existing roads (or hold Ctrl while dragging)' },
      icon(ICONS.road),
      h('span', { class: 'tool-label' }, 'Overpass'),
      h('span', { class: 'tool-cost' }, road.overpass ? 'on' : 'off'),
    );
    over.addEventListener('click', () => {
      road.overpass = !road.overpass;
      showRoadTypes();
    });
    host.append(over);
    host.classList.remove('hidden');
  };

  const hideSub = (): void => {
    ui.subToolbar.classList.add('hidden');
    clear(ui.subToolbar);
  };

  game.events.on('tool', (tool) => {
    if (tool === road) showRoadTypes();
    else hideSub();
  });

  ui.addToolButton({
    id: 'road',
    label: 'Roads',
    icon: ICONS.road,
    hotkey: 'R',
    onClick: () => game.setTool(game.tool === road ? null : road),
    isActive: () => game.tool === road,
  });
  ui.addToolButton({
    id: 'bulldoze',
    label: 'Bulldoze',
    icon: ICONS.bulldoze,
    hotkey: 'B',
    onClick: () => game.setTool(game.tool === bulldoze ? null : bulldoze),
    isActive: () => game.tool === bulldoze,
  });
  return { road, bulldoze };
}
