import { CState } from '../../city/City';
import { BState, PROBLEM_TEXT, type Building } from '../../city/buildings';
import { Zone, ZONE_INFO } from '../../city/zones';
import type { Game } from '../../game/Game';
import { h } from '../dom';
import { kvList, makePanel } from './panel';

const STATE_NAMES = ['Under construction', 'Active', 'Abandoned'];

function meter(): { el: HTMLElement; set: (v: number) => void } {
  const fill = h('i');
  const el = h('div', { class: 'meter' }, fill);
  return {
    el,
    set: (v) => {
      const p = Math.max(0, Math.min(100, v));
      fill.style.width = `${p}%`;
      fill.style.background = p >= 65 ? 'var(--good)' : p >= 40 ? 'var(--warn)' : 'var(--bad)';
    },
  };
}

function rows(b: Building): string[] {
  const base = ['State', 'Level'];
  switch (b.zone) {
    case Zone.Residential:
      return [...base, 'Residents', 'Workers with a job', 'At home now', 'Average commute', 'Shopping trips OK'];
    case Zone.Commercial:
      return [...base, 'Workers', 'Goods in stock', 'Customers (recent)', 'Goods on the way'];
    case Zone.Industrial:
      return [...base, 'Workers', 'Crops in stock', 'Goods in stock', 'Raw materials from ground', 'Produced'];
    default:
      return [...base, 'Workers', 'Crops in stock', 'Produced'];
  }
}

/** Details of a building: residents or workers, stock, happiness and problems. */
export function openBuildingPanel(game: Game, id: number): void {
  const world = game.world!;
  const b0 = world.city.buildings[id];
  if (!b0) return;
  const handle = makePanel(b0.template.name, () => game.tools.inspect.select(null));
  const info = ZONE_INFO[b0.zone];
  const zoneTag = h('div', { class: 'zone-tag' }, h('i', { style: { background: info.color } }), `${info.name} zone`);
  const kv = kvList(rows(b0));
  const happyLabel = h('div', { class: 'section-title' }, b0.zone === Zone.Residential ? 'Happiness' : 'Business health');
  const happy = meter();
  const problemsTitle = h('div', { class: 'section-title' }, 'Problems');
  const problems = h('ul', { class: 'problem-list' });
  const hint = h('p', { class: 'hint' });
  const demolish = h('button', { class: 'btn small danger', type: 'button' }, 'Demolish');
  demolish.addEventListener('click', () => {
    world.city.removeBuilding(id);
    game.tools.inspect.select(null);
  });
  handle.body.append(zoneTag, kv.el, happyLabel, happy.el, problemsTitle, problems, hint, h('div', { class: 'row' }, demolish));

  let lastProblems = -1;
  const refresh = (): void => {
    const b = world.city.buildings[id];
    if (!b || b !== b0) {
      kv.set(rows(b0).map(() => '-'));
      problems.replaceChildren(h('li', null, 'This building was demolished.'));
      return;
    }
    const cap = b.capacity;
    const state = b.state === BState.Construction ? `${STATE_NAMES[0]} (${Math.round(100 - (b.build / 25) * 100)}%)` : STATE_NAMES[b.state];
    const vals: Array<string | number> = [state, `${b.level} / 3`];
    if (b.zone === Zone.Residential) {
      let workers = 0;
      let employed = 0;
      let home = 0;
      for (const cid of b.people) {
        const c = world.city.citizens[cid];
        if (!c) continue;
        if (c.worker) {
          workers++;
          if (c.job) employed++;
        }
        if (c.state === CState.Home) home++;
      }
      vals.push(`${b.people.length} / ${cap}${b.pending ? ` (+${b.pending} moving in)` : ''}`, `${employed} / ${workers}`, home, b.commute ? `${(b.commute / 60).toFixed(1)} min` : '-', `${Math.round(b.shopOk * 100)}%`);
      hint.textContent =
        b.level < 3 ? 'Happy homes (jobs, shops nearby, short commutes, quiet streets) grow to the next level and house more people.' : 'This home has reached the highest level.';
    } else if (b.zone === Zone.Commercial) {
      vals.push(`${b.people.length} / ${cap}`, Math.floor(b.goods), Math.round(b.customers), Math.round(b.incoming));
      hint.textContent = 'Shops sell goods made by factories. Trucks deliver them; without factories goods are imported.';
    } else if (b.zone === Zone.Industrial) {
      vals.push(`${b.people.length} / ${cap}`, Math.floor(b.crops), Math.floor(b.goods), `${Math.round(b.rich * 100)}%`, Math.round(b.produced));
      hint.textContent = 'Factories turn crops from farms into goods for shops. On rich ground they extract raw materials themselves.';
    } else {
      vals.push(`${b.people.length} / ${cap}`, Math.floor(b.crops), Math.round(b.produced));
      hint.textContent = 'Farms grow crops that trucks bring to factories; surplus is exported.';
    }
    kv.set(vals);
    happy.set(b.happiness);
    if (b.shownProblems !== lastProblems) {
      lastProblems = b.shownProblems;
      const items: HTMLElement[] = [];
      for (const [bit, text] of Object.entries(PROBLEM_TEXT)) if (b.shownProblems & Number(bit)) items.push(h('li', null, text));
      problems.replaceChildren(...(items.length ? items : [h('li', { class: 'ok' }, 'No problems')]));
    }
  };
  refresh();
  const timer = window.setInterval(refresh, 400);
  handle.el.addEventListener('closed', () => window.clearInterval(timer));
  game.ui.openPanel(handle.el, 'inspect');
}
