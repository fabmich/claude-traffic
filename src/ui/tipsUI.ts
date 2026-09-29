import type { Game } from '../game/Game';
import { Zone } from '../city/zones';
import { h, icon } from './dom';
import { ICONS } from './icons';

const HIDE_KEY = 'trafficcity.tips.hidden';

interface Step {
  text: string;
  done: (game: Game) => boolean;
}

const STEPS: Step[] = [
  { text: 'Build a road from the highway exit into the land (Roads, R)', done: (g) => !!g.world?.city.connected },
  { text: 'Zone homes next to your roads (Zones, Z)', done: (g) => !!g.world?.city.zones.some((z) => z === Zone.Residential) },
  { text: 'Add jobs: zone industry and shops too', done: (g) => !!g.world?.city.zones.some((z) => z === Zone.Industrial || z === Zone.Commercial) },
  { text: 'Grow to 100 residents', done: (g) => (g.world?.city.population ?? 0) >= 100 },
  {
    text: 'Fix a busy junction: click it and try lights, signs or lane arrows',
    done: (g) => {
      const w = g.world;
      if (!w) return false;
      for (const [, s] of w.junctions.entries()) if (s.control || s.lanes || s.signs) return true;
      return false;
    },
  },
];

/** A small "getting started" checklist that ticks itself off while the player builds. */
export function setupTips(game: Game): void {
  let hidden = false;
  try {
    hidden = localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    // Storage blocked: show the tips.
  }
  const items = STEPS.map((s) => h('li', null, h('span', { class: 'tick' }), s.text));
  const close = h('button', { class: 'icon-btn', type: 'button', title: 'Hide tips' }, icon(ICONS.close));
  const card = h('div', { class: 'tips panel' }, h('div', { class: 'tips-head' }, h('b', null, 'Getting started'), close), h('ol', null, ...items));
  const hide = (): void => {
    hidden = true;
    card.remove();
    try {
      localStorage.setItem(HIDE_KEY, '1');
    } catch {
      // Hidden for this session only.
    }
  };
  close.addEventListener('click', hide);
  let doneAt = 0;
  game.ui.refreshers.push(() => {
    if (hidden || !game.world) return;
    if (!card.isConnected) game.ui.layer.append(card);
    let all = true;
    STEPS.forEach((s, i) => {
      const ok = s.done(game);
      items[i].classList.toggle('done', ok);
      all &&= ok;
    });
    if (all) {
      doneAt ||= performance.now();
      if (performance.now() - doneAt > 6000) hide();
    }
  });
}
