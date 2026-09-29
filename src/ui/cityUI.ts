import { UNLOCK } from '../config';
import { CITY, type Budget } from '../city/City';
import { BState, Problem } from '../city/buildings';
import { Zone, ZONE_INFO } from '../city/zones';
import { formatInt, formatMoney } from '../core/math';
import type { Game } from '../game/Game';
import { ZoneTool } from '../input/tools/ZoneTool';
import { drawBuildingLights, drawHappinessOverlay, drawProblemIcons } from '../render/buildingDraw';
import { ROAD_TYPES } from '../roads/roadTypes';
import { VKind } from '../sim/params';
import { h } from './dom';
import { ICONS } from './icons';
import { kvList, makePanel } from './panels/panel';
import { subButton } from './toolbarSetup';

export interface CityToolset {
  zone: ZoneTool;
  openCityPanel: (tab?: CityTab) => void;
}

type CityTab = 'overview' | 'budget' | 'milestones';

const DEMAND_KEYS = [
  ['r', Zone.Residential],
  ['c', Zone.Commercial],
  ['i', Zone.Industrial],
  ['f', Zone.Farming],
] as const;

const ZONE_HINTS: Record<number, string> = {
  [Zone.Residential]: 'Homes. Residents need jobs and shops',
  [Zone.Commercial]: 'Shops. Need customers and goods from factories',
  [Zone.Industrial]: 'Factories. Need workers and crops (or rich ground)',
  [Zone.Farming]: 'Farms. Only on farmland; supply crops to factories',
};

const UNLOCK_NAMES: Record<keyof typeof UNLOCK, string> = {
  signals: 'Traffic lights',
  roundabout: 'Roundabouts',
  roundaboutLarge: 'Large roundabouts',
  buses: 'Buses',
  truckBan: 'Truck bans',
  busLane: 'Bus lanes',
};

/** Features that unlock when the population reaches `pop`. */
export function unlocksAt(pop: number): string[] {
  const out: string[] = [];
  for (const t of ROAD_TYPES) if (t.id && !t.hidden && t.unlockPop === pop) out.push(t.name);
  for (const k of Object.keys(UNLOCK) as Array<keyof typeof UNLOCK>) if (UNLOCK[k] === pop) out.push(UNLOCK_NAMES[k]);
  return out;
}

function zoneSwatch(color: string): string {
  return `<svg viewBox="0 0 28 24" width="28" height="24"><rect x="4" y="3" width="20" height="18" rx="4" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="2"/></svg>`;
}

/** Advice for the player based on the state of the city. */
function advice(game: Game): string[] {
  const world = game.world!;
  const city = world.city;
  const out: string[] = [];
  const live = city.buildings.filter((b) => b && b.state === BState.Active);
  const count = (p: number): number => live.filter((b) => b!.shownProblems & p).length;
  const zoned = (z: number): boolean => city.zones.some((v) => v === z);
  if (!zoned(Zone.Residential)) out.push('Zone residential land next to your roads (Zones, Z). Houses grow when people want to move in.');
  if (count(Problem.NoConnection) > 0 || (city.population === 0 && live.length > 0)) out.push('Connect your roads to a highway exit at the map edge. New residents, imports and exports arrive from there.');
  if (count(Problem.NoRoad) > 0) out.push('Some buildings lost their road access. Reconnect them or demolish them.');
  const unemployment = city.workers ? 1 - city.employed / city.workers : 0;
  if ((city.workers > 20 && unemployment > 0.12) || count(Problem.NoJobs) > 2) out.push(`${Math.round(unemployment * 100)}% of workers are unemployed. Zone more industry, farms or commerce.`);
  if (count(Problem.NoWorkers) > 2) out.push('Workplaces cannot find enough workers. Zone more homes, or make commutes easier.');
  if (count(Problem.NoGoods) > 0) out.push('Shops are running out of goods. Factories supply them; imports come by truck from the highway.');
  if (count(Problem.NoInputs) > 0) out.push('Factories need crops. Zone farms on farmland, or put industry on rich ground (purple).');
  if (count(Problem.NoCustomers) > 2) out.push('Some shops lack customers. Commercial demand is low; zone more homes nearby.');
  if (city.commuteMinutes > 5) out.push(`Commutes take ${city.commuteMinutes.toFixed(1)} min on average. Check the Junction delays view and improve busy junctions.`);
  if (world.traffic.stats.flow < 0.55 && world.traffic.count > 30) out.push('Traffic is congested. Add lanes, alternative routes, traffic lights or roundabouts.');
  if (!world.sandbox && world.money < 0) out.push('You are in debt. Raise taxes a little or reduce road upkeep.');
  if (city.happiness < 45 && city.population > 50) out.push('Residents are unhappy. Jobs, shops, short commutes and quiet streets make them happier.');
  if (out.length === 0) out.push('Everything is running smoothly. Keep growing your city!');
  return out;
}

/** City tools and panels: zoning, demand bars, budget, statistics, milestones and building icons. */
export function setupCityUI(game: Game): CityToolset {
  const ui = game.ui;
  const zone = new ZoneTool(game);
  const sub = game.tools.showSub;

  // ------------------------------------------------------------ zoning
  const renderZones = (host: HTMLElement): void => {
    for (const [, z] of DEMAND_KEYS) {
      const info = ZONE_INFO[z];
      host.append(
        subButton({
          label: info.name,
          html: zoneSwatch(info.color),
          title: `${info.name}: ${ZONE_HINTS[z]}. Drag a rectangle near roads.`,
          active: zone.zone === z,
          onClick: () => {
            zone.zone = z;
            sub(renderZones, 'zone');
          },
        }),
      );
    }
    host.append(
      subButton({
        label: 'Remove zoning',
        icon: ICONS.bulldoze,
        title: 'Remove zoning from empty land (existing buildings stay)',
        active: zone.zone === Zone.None,
        onClick: () => {
          zone.zone = Zone.None;
          sub(renderZones, 'zone');
        },
      }),
    );
  };
  game.events.on('tool', (tool) => {
    if (tool === zone) sub(renderZones, 'zone');
    else if (game.tools.subOwner() === 'zone') sub(null);
  });
  ui.addToolButton({
    id: 'zone',
    label: 'Zones',
    icon: ICONS.zone,
    hotkey: 'Z',
    title: 'Zone land for homes, shops, industry and farms (Z)',
    onClick: () => game.setTool(game.tool === zone ? null : zone),
    isActive: () => game.tool === zone,
  });

  // ------------------------------------------------------------ demand bars
  const bars = DEMAND_KEYS.map(([k, z]) => {
    const fill = h('i');
    const el = h('div', { class: 'demand-bar' }, fill, h('b', null, ZONE_INFO[z].short));
    return { k, z, el, fill };
  });
  ui.addExtra(h('div', { class: 'tb-group demand-group clickable', title: 'Demand for new zones (click for details)', onclick: () => openCityPanel('overview') }, h('div', { class: 'demand' }, ...bars.map((b) => b.el))), true);
  ui.refreshers.push(() => {
    const world = game.world;
    if (!world) return;
    const d = world.city.demand;
    for (const b of bars) {
      const v = Math.max(-1, Math.min(1, d[b.k]));
      const pct = Math.abs(v) * 50;
      b.fill.style.height = `${pct}%`;
      b.fill.style.bottom = v >= 0 ? '50%' : `${50 - pct}%`;
      b.fill.style.background = v >= 0 ? ZONE_INFO[b.z].color : 'rgba(120, 130, 140, 0.55)';
      b.el.title = `${ZONE_INFO[b.z].name} demand: ${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
    }
  });

  // ------------------------------------------------------------ city panel
  let tab: CityTab = 'overview';
  const openCityPanel = (t: CityTab = tab): void => {
    const world = game.world;
    if (!world) return;
    tab = t;
    const city = world.city;
    const handle = makePanel(world.options.cityName, () => ui.closePanels('city'));
    const tabs = h('div', { class: 'segmented tabs' });
    const body = h('div');
    handle.body.append(tabs, body);
    const refreshers: Array<() => void> = [];
    const show = (next: CityTab): void => {
      tab = next;
      tabs.replaceChildren(
        ...(['overview', 'budget', 'milestones'] as CityTab[]).map((k) => {
          const b = h('button', { class: `seg${k === tab ? ' active' : ''}`, type: 'button' }, k === 'overview' ? 'Overview' : k === 'budget' ? 'Budget' : 'Milestones');
          b.addEventListener('click', () => show(k));
          return b;
        }),
      );
      refreshers.length = 0;
      body.replaceChildren();
      if (tab === 'overview') {
        const kv = kvList(['Population', 'Workers', 'Unemployment', 'Jobs filled', 'Happiness', 'Average commute', 'Trips today', 'Car / walk / bus', 'Buildings (R / C / I / F)', 'Trucks on the road']);
        const demandRows = DEMAND_KEYS.map(([k, z]) => {
          const fill = h('i');
          const val = h('span', { class: 'hbar-val' });
          const row = h('div', { class: 'hbar-row' }, h('span', { class: 'hbar-name' }, ZONE_INFO[z].name), h('div', { class: 'hbar' }, fill), val);
          return { k, z, row, fill, val };
        });
        const tips = h('ul', { class: 'advice' });
        body.append(kv.el, h('div', { class: 'section-title' }, 'Demand'), ...demandRows.map((r) => r.row), h('div', { class: 'section-title' }, 'Advisor'), tips);
        let tick = 0;
        refreshers.push(() => {
          const counts = [0, 0, 0, 0, 0];
          for (const b of city.buildings) if (b && b.state !== BState.Abandoned) counts[b.zone]++;
          const total = city.modeCounts.car + city.modeCounts.walk + city.modeCounts.bus;
          const pct = (n: number): string => `${total ? Math.round((n / total) * 100) : 0}%`;
          let trucks = 0;
          for (const v of world.traffic.vehicles) if (v.kind === VKind.Truck) trucks++;
          kv.set([
            formatInt(city.population),
            formatInt(city.workers),
            city.workers ? `${Math.round((1 - city.employed / city.workers) * 100)}%` : '-',
            `${formatInt(city.employed)} / ${formatInt(city.jobs)}`,
            `${Math.round(city.happiness)} / 100`,
            city.commuteMinutes ? `${city.commuteMinutes.toFixed(1)} min` : '-',
            total ? formatInt(total) : '-',
            total ? `${pct(city.modeCounts.car)} / ${pct(city.modeCounts.walk)} / ${pct(city.modeCounts.bus)}` : '-',
            `${counts[1]} / ${counts[2]} / ${counts[3]} / ${counts[4]}`,
            formatInt(trucks),
          ]);
          for (const r of demandRows) {
            const v = Math.max(-1, Math.min(1, city.demand[r.k]));
            r.fill.style.width = `${Math.abs(v) * 50}%`;
            r.fill.style.left = v >= 0 ? '50%' : `${50 - Math.abs(v) * 50}%`;
            r.fill.style.background = v >= 0 ? ZONE_INFO[r.z].color : 'var(--faint)';
            r.val.textContent = `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`;
          }
          if (tick++ % 4 === 0) tips.replaceChildren(...advice(game).map((t) => h('li', null, t)));
        });
      } else if (tab === 'budget') {
        const incomeRows: Array<[keyof Budget, string]> = [
          ['residential', 'Residential tax'],
          ['commercial', 'Commercial tax'],
          ['industrial', 'Industrial tax'],
          ['farming', 'Farming tax'],
          ['exports', 'Exports'],
          ['fares', 'Bus fares'],
        ];
        const expenseRows: Array<[keyof Budget, string]> = [
          ['roads', 'Road upkeep'],
          ['junctions', 'Lights & roundabouts'],
          ['transit', 'Public transport'],
          ['imports', 'Imports'],
        ];
        const cells = new Map<string, [HTMLElement, HTMLElement]>();
        const row = (key: string, label: string, cls = ''): HTMLElement => {
          const a = h('td', { class: 'num' });
          const b = h('td', { class: 'num' });
          cells.set(key, [a, b]);
          return h('tr', { class: cls }, h('td', null, label), a, b);
        };
        const table = h(
          'table',
          { class: 'budget' },
          h('tr', { class: 'head' }, h('th', null, ''), h('th', null, 'Today'), h('th', null, 'Yesterday')),
          h('tr', { class: 'group' }, h('td', { colspan: 3 }, 'Income')),
          ...incomeRows.map(([k, l]) => row(k, l)),
          row('income', 'Total income', 'total'),
          h('tr', { class: 'group' }, h('td', { colspan: 3 }, 'Expenses')),
          ...expenseRows.map(([k, l]) => row(k, l)),
          row('expenses', 'Total expenses', 'total'),
          row('net', 'Net', 'net'),
        );
        const taxes = h('div', { class: 'tax-list' });
        for (const [k, z] of DEMAND_KEYS) {
          const val = h('span', { class: 'tax-val' }, `${city.taxes[k]}%`);
          const input = h('input', { type: 'range', min: 1, max: 25, step: 1, value: String(city.taxes[k]), class: 'slider' }) as HTMLInputElement;
          input.addEventListener('input', () => {
            city.taxes[k] = Number(input.value);
            val.textContent = `${input.value}%`;
          });
          taxes.append(h('div', { class: 'tax-row' }, h('span', { class: 'tax-name' }, h('i', { style: { background: ZONE_INFO[z].color } }), ZONE_INFO[z].name), input, val));
        }
        body.append(
          table,
          h('div', { class: 'section-title' }, 'Taxes'),
          taxes,
          h('p', { class: 'hint' }, 'Higher taxes bring in more money but lower demand and happiness. Around 9% keeps everyone content.'),
        );
        refreshers.push(() => {
          const set = (key: string, today: number, yesterday: number, sign = 1): void => {
            const c = cells.get(key);
            if (!c) return;
            c[0].textContent = formatMoney(today * sign);
            c[1].textContent = world.clock.day > 1 ? formatMoney(yesterday * sign) : '-';
          };
          const t = city.budgetToday;
          const y = city.budgetYesterday;
          for (const [k] of incomeRows) set(k, t[k], y[k]);
          for (const [k] of expenseRows) set(k, t[k], y[k], -1);
          set('income', city.income(t), city.income(y));
          set('expenses', city.expenses(t), city.expenses(y), -1);
          set('net', city.income(t) - city.expenses(t), city.income(y) - city.expenses(y));
        });
      } else {
        const list = h('div', { class: 'milestones' });
        body.append(list);
        refreshers.push(() => {
          const items = CITY.milestones.map((m, i) => {
            const done = i < city.milestone;
            const next = i === city.milestone;
            const unlocks = unlocksAt(m.pop);
            const prog = next ? Math.min(1, city.population / m.pop) : done ? 1 : 0;
            return h(
              'div',
              { class: `milestone${done ? ' done' : ''}${next ? ' next' : ''}` },
              h('div', { class: 'ms-head' }, h('b', null, m.name), h('span', null, `${formatInt(m.pop)} residents`)),
              h('div', { class: 'ms-sub' }, `Reward ${formatMoney(m.reward)}${unlocks.length ? ` · unlocks ${unlocks.join(', ')}` : ''}`),
              next ? h('div', { class: 'meter' }, h('i', { style: { width: `${prog * 100}%`, background: 'var(--accent)' } })) : null,
            );
          });
          list.replaceChildren(...items);
        });
      }
      for (const r of refreshers) r();
    };
    show(tab);
    const timer = window.setInterval(() => {
      for (const r of refreshers) r();
    }, 500);
    handle.el.addEventListener('closed', () => window.clearInterval(timer));
    ui.openPanel(handle.el, 'city');
  };
  ui.onStatClick('population', () => openCityPanel('overview'));
  ui.onStatClick('money', () => openCityPanel('budget'));
  ui.addToolButton({
    id: 'city',
    label: 'City',
    icon: ICONS.chart,
    hotkey: 'C',
    title: 'City statistics, budget, taxes and milestones (C)',
    onClick: () => {
      if (ui.hasPanel('city')) ui.closePanels('city');
      else openCityPanel();
    },
    isActive: () => ui.hasPanel('city'),
  });

  // ------------------------------------------------------------ milestones & notices
  const bindWorld = (): void => {
    const world = game.world;
    if (!world) return;
    world.city.events.on('milestone', (m) => {
      const unlocks = unlocksAt(m.pop);
      const card = h(
        'div',
        { class: 'milestone-card panel' },
        h('div', { class: 'mc-title' }, `${m.name}!`),
        h('div', { class: 'mc-sub' }, `${formatInt(m.pop)} residents · reward ${world.sandbox ? 'n/a in sandbox' : formatMoney(m.reward)}`),
        unlocks.length ? h('div', { class: 'mc-unlocks' }, h('b', null, 'Unlocked: '), unlocks.join(' · ')) : null,
      );
      card.addEventListener('click', () => card.remove());
      ui.layer.append(card);
      window.setTimeout(() => card.classList.add('fade'), 7000);
      window.setTimeout(() => card.remove(), 7600);
    });
    world.city.events.on('notice', (text) => ui.toast(text, 'info', 5000));
  };
  game.events.on('newGame', bindWorld);

  // ------------------------------------------------------------ building overlays
  game.renderer.overlayDrawers.unshift(
    (ctx, r) => {
      if (!game.world) return;
      if (game.overlay === 'happiness') drawHappinessOverlay(ctx, r, game.world);
      else drawBuildingLights(ctx, r, game.world);
    },
    (ctx, r) => {
      if (game.world) drawProblemIcons(ctx, r, game.world, performance.now() / 1000);
    },
  );

  ui.orderToolbar(['road', 'zone', 'bulldoze', 'junction', 'lanes', 'speed', 'transit', 'views', 'city']);
  return { zone, openCityPanel };
}
