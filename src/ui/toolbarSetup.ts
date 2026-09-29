import { LANE_W } from '../config';
import { formatMoney } from '../core/math';
import type { Game } from '../game/Game';
import { BulldozeTool } from '../input/tools/BulldozeTool';
import { InspectTool } from '../input/tools/InspectTool';
import { RoadTool } from '../input/tools/RoadTool';
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
  return game.ui.unlockPopulation >= t.unlockPop;
}

/** A button for the secondary toolbar. */
export function subButton(opts: { label: string; icon?: string; html?: string; sub?: string; title?: string; active?: boolean; locked?: boolean; onClick: () => void }): HTMLButtonElement {
  const b = h(
    'button',
    { class: 'tool-btn' + (opts.active ? ' active' : '') + (opts.locked ? ' locked' : ''), type: 'button', title: opts.title ?? opts.label },
    opts.html ? h('span', { class: 'swatch', html: opts.html }) : icon(opts.icon ?? ICONS.cursor),
    h('span', { class: 'tool-label' }, opts.label),
    opts.sub !== undefined ? h('span', { class: 'tool-cost' }, opts.sub) : null,
  );
  b.addEventListener('click', opts.onClick);
  return b;
}

export interface Toolset {
  inspect: InspectTool;
  road: RoadTool;
  bulldoze: BulldozeTool;
  /** Shows option buttons for a toolbar group in the secondary toolbar (or hides it). */
  showSub: (render: ((host: HTMLElement) => void) | null, owner?: string) => void;
  subOwner: () => string | null;
}

/** Registers the main toolbar tools. Other modules add more groups through `showSub`. */
export function setupToolbar(game: Game): Toolset {
  const ui = game.ui;
  const inspect = new InspectTool(game);
  const road = new RoadTool(game);
  const bulldoze = new BulldozeTool(game);
  let owner: string | null = null;
  let currentRender: ((host: HTMLElement) => void) | null = null;

  const showSub = (render: ((host: HTMLElement) => void) | null, who?: string): void => {
    const host = ui.subToolbar;
    clear(host);
    currentRender = render;
    owner = render ? (who ?? null) : null;
    if (!render) {
      host.classList.add('hidden');
      return;
    }
    render(host);
    host.classList.remove('hidden');
  };
  const refreshSub = (): void => {
    if (currentRender) showSub(currentRender, owner ?? undefined);
  };

  const renderRoadTypes = (host: HTMLElement): void => {
    for (const t of ROAD_TYPES) {
      if (t.id === 0 || t.hidden) continue;
      const unlocked = isRoadUnlocked(game, t);
      host.append(
        subButton({
          label: t.name,
          html: roadSwatch(t),
          sub: unlocked ? `${formatMoney(t.cost)}/tile` : `🔒 ${t.unlockPop.toLocaleString('en-US')} pop`,
          title: `${t.name}: ${t.description} (${t.speedKmh} km/h)`,
          active: road.typeId === t.id,
          locked: !unlocked,
          onClick: () => {
            if (!unlocked) {
              ui.toast(`${t.name} unlocks at ${t.unlockPop.toLocaleString('en-US')} population`, 'warn');
              return;
            }
            road.typeId = t.id;
            refreshSub();
          },
        }),
      );
    }
    host.append(
      subButton({
        label: 'Overpass',
        icon: ICONS.road,
        sub: road.overpass ? 'on' : 'off',
        title: 'Overpass: build a straight bridge over existing roads (or hold Ctrl while dragging)',
        active: road.overpass,
        onClick: () => {
          road.overpass = !road.overpass;
          refreshSub();
        },
      }),
    );
  };

  game.events.on('tool', (tool) => {
    if (tool === road) showSub(renderRoadTypes, 'road');
    else if (owner === 'road' || owner === 'bulldoze') showSub(null);
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

  // Views: overlays and test traffic.
  const renderViews = (host: HTMLElement): void => {
    const world = game.world;
    host.append(
      subButton({
        label: 'Traffic flow',
        icon: ICONS.car,
        sub: game.overlay === 'traffic' ? 'on' : 'off',
        title: 'Colour roads by congestion (green = free flow, red = jam)',
        active: game.overlay === 'traffic',
        onClick: () => {
          game.setOverlay(game.overlay === 'traffic' ? 'none' : 'traffic');
          refreshSub();
        },
      }),
    );
    for (const [kind, label, title] of [
      ['delays', 'Junction delays', 'Average waiting time at each junction'],
      ['speed', 'Speed limits', 'Show the speed limit of every road'],
      ['happiness', 'Happiness', 'Colour buildings by happiness (green = happy, red = unhappy)'],
    ] as Array<['delays' | 'speed' | 'happiness', string, string]>) {
      host.append(
        subButton({
          label,
          icon: kind === 'delays' ? ICONS.clock : kind === 'speed' ? ICONS.speed : ICONS.people,
          sub: game.overlay === kind ? 'on' : 'off',
          title,
          active: game.overlay === kind,
          onClick: () => {
            game.setOverlay(game.overlay === kind ? 'none' : kind);
            refreshSub();
          },
        }),
      );
    }
    if (world) {
      const gen = world.generator;
      host.append(
        subButton({
          label: 'Test traffic',
          icon: ICONS.truck,
          sub: gen.enabled ? `${gen.rate}/min` : 'off',
          title: 'Spawn random trips to test your road design',
          active: gen.enabled,
          onClick: () => {
            gen.enabled = !gen.enabled;
            refreshSub();
          },
        }),
      );
      for (const rate of [15, 40, 100]) {
        host.append(
          subButton({
            label: `${rate}/min`,
            icon: ICONS.chart,
            active: gen.enabled && gen.rate === rate,
            onClick: () => {
              gen.rate = rate;
              gen.enabled = true;
              refreshSub();
            },
          }),
        );
      }
    }
  };
  ui.addToolButton({
    id: 'views',
    label: 'Views',
    icon: ICONS.eye,
    hotkey: 'V',
    onClick: () => {
      if (owner === 'views') showSub(null);
      else {
        game.setTool(null);
        showSub(renderViews, 'views');
      }
    },
    isActive: () => owner === 'views',
  });

  // Live traffic readout in the top bar.
  const flowEl = h('span', { class: 'value' }, '100%');
  const vehEl = h('span', { class: 'value' }, '0');
  ui.setExtra(
    h(
      'div',
      { class: 'tb-extra-inner' },
      h('div', { class: 'tb-group stat', title: 'Traffic flow: average speed compared to the speed limit' }, icon(ICONS.speed), flowEl),
      h('div', { class: 'tb-group stat', title: 'Vehicles on the road' }, icon(ICONS.car), vehEl),
    ),
  );
  ui.refreshers.push(() => {
    const world = game.world;
    if (!world) return;
    const f = Math.round(world.traffic.stats.flow * 100);
    flowEl.textContent = `${f}%`;
    flowEl.style.color = f >= 75 ? 'var(--good)' : f >= 50 ? 'var(--warn)' : 'var(--bad)';
    vehEl.textContent = world.traffic.count.toLocaleString('en-US');
  });

  return { inspect, road, bulldoze, showSub, subOwner: () => owner };
}
