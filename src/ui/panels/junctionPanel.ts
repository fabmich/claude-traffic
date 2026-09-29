import { UNLOCK } from '../../config';
import { formatMoney } from '../../core/math';
import type { Game } from '../../game/Game';
import { allExitsFor, targetLanes } from '../../roads/laneDefaults';
import type { Arm, ControlKind, Lane, RoadNode } from '../../roads/network';
import type { SignalPlanSetting, SignKind } from '../../roads/settings';
import { PRIO_MAIN, PRIO_STOP } from '../../sim/junctions';
import { defaultSignalPlan, groupKey, MOVEMENT_NAMES } from '../../sim/signals';
import { clear, h } from '../dom';
import { makePanel } from './panel';

export const DIR_LONG = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

/** SVG arrow for a turn index k (0 straight, 1-3 right, 4 U-turn, 5-7 left). */
export function turnArrowSvg(k: number): string {
  if (k === 4) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21V10a4 4 0 0 0-8 0v3"/><path d="M4 11l3 3 3-3"/></svg>`;
  }
  const angle = k <= 3 ? k * 45 : -(8 - k) * 45;
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(${angle}deg)"><path d="M12 21V4"/><path d="M6 10l6-6 6 6"/></svg>`;
}

const TURN_LABEL = ['Straight', 'Slight right', 'Right', 'Sharp right', 'U-turn', 'Sharp left', 'Left', 'Slight left'];

function locked(game: Game, need: number): boolean {
  const w = game.world;
  return !!w && !w.sandbox && game.ui.unlockPopulation < need;
}

/** Current (compiled) targets of an incoming lane as [outDir, outLaneIndex] pairs. */
export function laneTargets(lane: Lane): Array<[number, number]> {
  return lane.outs.map((c) => [c.outArm.dir, c.to.index] as [number, number]);
}

/** Adds or removes an exit for one lane (quick lane-arrow editing). */
export function toggleExit(game: Game, node: RoadNode, arm: Arm, lane: Lane, exit: Arm, k: number): void {
  const world = game.world!;
  const cur = laneTargets(lane);
  const has = cur.some(([d]) => d === exit.dir);
  let next: Array<[number, number]>;
  if (has) next = cur.filter(([d]) => d !== exit.dir);
  else {
    // Lanes of this arm that will serve the exit after the change, curb first.
    const serving = arm.ins.filter((l) => l === lane || l.outs.some((c) => c.outArm === exit));
    const rank = serving.indexOf(lane);
    const outs = targetLanes(rank, serving.length, exit.outs.length, k).map((o) => [exit.dir, o] as [number, number]);
    next = [...cur, ...outs];
  }
  world.setLaneTargets(node.tile, arm.dir, lane.index, next);
}

/**
 * Junction editor: traffic control (auto, priority signs, all-way stop, lights, roundabout),
 * signal phases and the lane manager.
 */
export function openJunctionPanel(game: Game, tile: number): void {
  const world = game.world;
  if (!world) return;
  const handle = makePanel('Junction', () => {
    game.tools.inspect.select(null);
    if (game.tool === game.trafficTools.lane) game.setTool(null);
  });
  const statsEls: Array<{ lane: Lane; el: HTMLElement }> = [];

  const render = (): void => {
    const w = game.world;
    if (!w) return;
    clear(handle.body);
    statsEls.length = 0;
    const nodes = w.junctionNodes(tile);
    if (nodes.length === 0) {
      handle.body.append(h('p', { class: 'hint' }, 'This junction no longer exists.'));
      return;
    }
    const node = nodes[0];
    const ring = node.ringOf !== null;
    const setting = w.junctions.get(tile);
    const kind: ControlKind = ring ? 'roundabout' : (setting?.control ?? 'auto');
    const arms = w.junctionArmCount(tile);
    handle.title.textContent = ring ? `Roundabout (${arms} roads)` : `Junction (${arms} roads)`;

    // Control type.
    const opts: Array<{ k: ControlKind; label: string; need?: number; title: string }> = [
      { k: 'auto', label: 'Auto', title: 'Bigger road has priority; equal roads: priority to the right' },
      { k: 'priority', label: 'Signs', title: 'Choose main road, yield and stop signs per road' },
      { k: 'allstop', label: 'All-way stop', title: 'Everybody stops, first come first served' },
      { k: 'signals', label: `Lights ${formatMoney(w.controlCost('signals'))}`, need: UNLOCK.signals, title: 'Traffic lights with editable phases' },
      { k: 'roundabout', label: `Roundabout ${formatMoney(w.controlCost('roundabout'))}`, need: UNLOCK.roundabout, title: 'Traffic circulates; entering cars give way' },
    ];
    const seg = h('div', { class: 'segmented wrap' });
    for (const o of opts) {
      const isLocked = o.need !== undefined && locked(game, o.need);
      const b = h('button', { class: 'seg' + (kind === o.k ? ' active' : '') + (isLocked ? ' locked' : ''), type: 'button', title: o.title }, o.label);
      b.addEventListener('click', () => {
        if (isLocked) {
          game.ui.toast(`Unlocks at ${o.need!.toLocaleString('en-US')} population`, 'warn');
          return;
        }
        const err = w.setJunctionControl(tile, o.k, o.k === 'roundabout' ? !!setting?.roundaboutLarge : false);
        if (err) game.ui.toast(err, 'warn');
        render();
      });
      seg.append(b);
    }
    handle.body.append(h('div', { class: 'section-title' }, 'Right of way'), seg);

    if (kind === 'priority' && !ring) renderSigns(node);
    if (kind === 'signals' && !ring) renderSignals(node);
    if (kind === 'roundabout') renderRoundabout();
    if (!ring) renderLanes(node);
    else handle.body.append(h('p', { class: 'hint' }, 'Vehicles in the roundabout have priority. Entering vehicles give way. Pick "Auto" to turn it back into a normal junction.'));
    renderStats(nodes);
  };

  const renderSigns = (node: RoadNode): void => {
    const w = game.world!;
    const ctrl = w.traffic.control(node);
    const box = h('div', { class: 'arm-list' });
    for (const arm of node.arms) {
      if (arm.ins.length === 0) continue;
      const p = ctrl.prio.get(arm) ?? PRIO_MAIN;
      const current: SignKind = p === PRIO_MAIN ? 'main' : p === PRIO_STOP ? 'stop' : 'yield';
      const s = h('div', { class: 'segmented' });
      for (const [k, label] of [
        ['main', 'Main'],
        ['yield', 'Yield'],
        ['stop', 'Stop'],
      ] as Array<[SignKind, string]>) {
        const b = h('button', { class: 'seg' + (current === k ? ' active' : ''), type: 'button' }, label);
        b.addEventListener('click', () => {
          w.setSign(tile, arm.dir, k);
          render();
        });
        s.append(b);
      }
      box.append(h('div', { class: 'arm-row' }, h('span', { class: 'arm-name' }, `From ${DIR_LONG[arm.dir]}`), s));
    }
    handle.body.append(h('div', { class: 'section-title' }, 'Signs'), box);
  };

  const renderSignals = (node: RoadNode): void => {
    const w = game.world!;
    const setting = w.junctions.get(tile);
    const plan: SignalPlanSetting = structuredClone(setting?.signalPlan ?? defaultSignalPlan(node));
    const save = (): void => {
      w.setSignalPlan(tile, plan);
      render();
    };
    const ctrl = w.traffic.control(node);
    const sig = ctrl.signal;
    const mode = h('div', { class: 'segmented' });
    for (const [act, label] of [
      [false, 'Fixed times'],
      [true, 'Smart (adapts to traffic)'],
    ] as Array<[boolean, string]>) {
      const b = h('button', { class: 'seg' + (plan.actuated === act ? ' active' : ''), type: 'button' }, label);
      b.addEventListener('click', () => {
        plan.actuated = act;
        save();
      });
      mode.append(b);
    }
    const approaches = node.arms.filter((a) => a.ins.length > 0);
    const phasesEl = h('div', { class: 'phase-list' });
    plan.phases.forEach((ph, i) => {
      const groups = new Set(ph.groups);
      const chips = h('div', { class: 'phase-groups' });
      for (const arm of approaches) {
        const row = h('div', { class: 'phase-arm' }, h('span', { class: 'arm-name small' }, DIR_LONG[arm.dir]));
        for (const m of [2, 1, 0]) {
          const key = groupKey(arm.dir, m);
          const k = m === 2 ? 6 : m === 1 ? 0 : 2;
          const b = h('button', { class: 'chip' + (groups.has(key) ? ' on' : ''), type: 'button', title: `${MOVEMENT_NAMES[m]} from ${DIR_LONG[arm.dir]}`, html: turnArrowSvg(k) });
          b.addEventListener('click', () => {
            if (groups.has(key)) groups.delete(key);
            else groups.add(key);
            ph.groups = [...groups];
            save();
          });
          row.append(b);
        }
        chips.append(row);
      }
      const green = h('input', { class: 'input num', type: 'number', min: 4, max: 90, value: String(ph.green), title: 'Green time (seconds)' }) as HTMLInputElement;
      green.addEventListener('change', () => {
        ph.green = Math.max(4, Math.min(90, Number(green.value) || 15));
        save();
      });
      const del = h('button', { class: 'btn small danger', type: 'button', title: 'Remove phase' }, '✕');
      del.addEventListener('click', () => {
        if (plan.phases.length <= 1) return;
        plan.phases.splice(i, 1);
        save();
      });
      const active = sig && sig.phaseIdx === i;
      phasesEl.append(
        h(
          'div',
          { class: 'phase' + (active ? ' current' : '') },
          h('div', { class: 'phase-head' }, h('b', null, `Phase ${i + 1}`), h('label', { class: 'inline' }, green, ' s green'), del),
          chips,
        ),
      );
    });
    const add = h('button', { class: 'btn small', type: 'button' }, '+ Add phase');
    add.addEventListener('click', () => {
      plan.phases.push({ green: 12, groups: [] });
      save();
    });
    const auto = h('button', { class: 'btn small', type: 'button' }, 'Auto-generate');
    auto.addEventListener('click', () => {
      const d = defaultSignalPlan(node);
      plan.phases = d.phases;
      save();
    });
    handle.body.append(
      h('div', { class: 'section-title' }, 'Traffic lights'),
      mode,
      h('p', { class: 'hint' }, 'Each phase gives green to the selected movements. Left turns that are green together with oncoming traffic must give way.'),
      phasesEl,
      h('div', { class: 'row' }, add, auto),
    );
  };

  const renderRoundabout = (): void => {
    const w = game.world!;
    const large = !!w.junctions.get(tile)?.roundaboutLarge;
    const s = h('div', { class: 'segmented' });
    for (const [lg, label] of [
      [false, `Small (1 lane) ${formatMoney(w.controlCost('roundabout', false))}`],
      [true, `Large (2 lanes) ${formatMoney(w.controlCost('roundabout', true))}`],
    ] as Array<[boolean, string]>) {
      const isLocked = lg && locked(game, UNLOCK.roundaboutLarge);
      const b = h('button', { class: 'seg' + (large === lg ? ' active' : '') + (isLocked ? ' locked' : ''), type: 'button' }, label);
      b.addEventListener('click', () => {
        if (isLocked) {
          game.ui.toast(`Unlocks at ${UNLOCK.roundaboutLarge.toLocaleString('en-US')} population`, 'warn');
          return;
        }
        const err = w.setJunctionControl(tile, 'roundabout', lg);
        if (err) game.ui.toast(err, 'warn');
        render();
      });
      s.append(b);
    }
    handle.body.append(h('div', { class: 'section-title' }, 'Roundabout size'), s);
  };

  const renderLanes = (node: RoadNode): void => {
    const w = game.world!;
    const editing = game.tool === game.trafficTools.lane && game.trafficTools.lane.tile === tile;
    const mapBtn = h('button', { class: 'btn small' + (editing ? ' primary' : ''), type: 'button', title: 'Click a lane end, then the lanes it should lead to' }, editing ? 'Editing on map…' : 'Connect lanes on map');
    mapBtn.addEventListener('click', () => {
      if (editing) game.setTool(null);
      else game.trafficTools.lane.edit(tile);
      render();
    });
    const reset = h('button', { class: 'btn small', type: 'button' }, 'Reset lanes');
    reset.addEventListener('click', () => {
      w.resetJunctionLanes(tile);
      render();
    });
    const box = h('div', { class: 'lane-manager' });
    const warnings: string[] = [];
    const reachable = new Set<number>();
    for (const arm of node.arms) {
      if (arm.ins.length === 0) continue;
      // Left to right, like painted lane arrows.
      const exits = allExitsFor(node, arm).reverse();
      const armBox = h('div', { class: 'lm-arm' }, h('div', { class: 'lm-arm-name' }, `From ${DIR_LONG[arm.dir]}`));
      // Driver's view: leftmost lane first.
      const lanes = [...arm.ins].sort((a, b) => b.index - a.index);
      lanes.forEach((lane, i) => {
        const row = h('div', { class: 'lm-lane' }, h('span', { class: 'lm-lane-name' }, `Lane ${i + 1}${lanes.length > 1 ? (i === 0 ? ' (left)' : i === lanes.length - 1 ? ' (right)' : '') : ''}`));
        const btns = h('div', { class: 'lm-arrows' });
        for (const ex of exits) {
          const on = lane.outs.some((c) => c.outArm === ex.arm);
          if (on) reachable.add(ex.arm.dir);
          const b = h('button', { class: 'chip' + (on ? ' on' : ''), type: 'button', title: `${TURN_LABEL[ex.k]} to ${DIR_LONG[ex.arm.dir]}`, html: turnArrowSvg(ex.k) });
          b.addEventListener('click', () => {
            toggleExit(game, node, arm, lane, ex.arm, ex.k);
            render();
          });
          btns.append(b);
        }
        const stat = h('span', { class: 'lm-stat' });
        statsEls.push({ lane, el: stat });
        row.append(btns, stat);
        if (lane.outs.length === 0) warnings.push(`Lane ${i + 1} from ${DIR_LONG[arm.dir]} has no direction: it is closed.`);
        armBox.append(row);
      });
      box.append(armBox);
    }
    for (const arm of node.arms) {
      if (arm.outs.length && !reachable.has(arm.dir) && node.arms.some((a) => a !== arm && a.ins.length)) warnings.push(`No lane leads ${DIR_LONG[arm.dir]}: turning there is banned.`);
    }
    handle.body.append(
      h('div', { class: 'section-title' }, 'Lane manager'),
      h('p', { class: 'hint' }, 'Choose which way each lane may go. Drivers pick the right lane well before the junction.'),
      box,
      ...warnings.map((t) => h('div', { class: 'warn-line' }, '⚠ ', t)),
      h('div', { class: 'row' }, mapBtn, reset),
    );
  };

  const renderStats = (nodes: RoadNode[]): void => {
    const w = game.world!;
    const passed = nodes.reduce((s, n) => s + w.traffic.control(n).passed, 0);
    handle.body.append(h('div', { class: 'section-title' }, 'Traffic'), h('p', { class: 'hint' }, `${passed.toLocaleString('en-US')} vehicles passed since the last change.`));
  };

  const refreshStats = (): void => {
    for (const { lane, el } of statsEls) {
      let queue = 0;
      for (const v of lane.vehicles) if (v.v < 1 && lane.length - v.s < 80) queue++;
      el.textContent = queue || lane.statWait > 0.5 ? `${queue} waiting · ${Math.round(lane.statWait)} s` : '';
    }
  };

  render();
  const timer = window.setInterval(refreshStats, 400);
  const off = world.events.on('network', () => render());
  handle.el.addEventListener('closed', () => {
    window.clearInterval(timer);
    off();
  });
  game.ui.openPanel(handle.el, 'inspect');
}
