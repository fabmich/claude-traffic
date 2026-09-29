import { UNLOCK } from '../config';
import { formatMoney } from '../core/math';
import type { Game } from '../game/Game';
import { JunctionTool, LaneTool, SpeedTool, type JunctionMode } from '../input/tools/trafficTools';
import { ICONS } from './icons';
import { setSegmentPanelHook } from './panels/inspectPanels';
import { openJunctionPanel } from './panels/junctionPanel';
import { openSegmentPanel } from './panels/segmentPanel';
import { subButton } from './toolbarSetup';

export interface TrafficToolset {
  lane: LaneTool;
  junction: JunctionTool;
  speed: SpeedTool;
}

/** Toolbar groups for junction control, lane editing and speed limits. */
export function setupTrafficTools(game: Game): TrafficToolset {
  const ui = game.ui;
  const lane = new LaneTool(game);
  const junction = new JunctionTool(game);
  const speed = new SpeedTool(game);
  const sub = game.tools.showSub;
  const locked = (need: number): boolean => {
    const w = game.world;
    return !!w && !w.sandbox && ui.population < need;
  };

  const renderJunctionModes = (host: HTMLElement): void => {
    const w = game.world;
    const modes: Array<{ m: JunctionMode; label: string; icon: string; sub: string; need?: number; title: string }> = [
      { m: 'signals', label: 'Traffic lights', icon: ICONS.light, sub: w ? formatMoney(w.controlCost('signals')) : '', need: UNLOCK.signals, title: 'Click a junction to add traffic lights' },
      { m: 'roundabout', label: 'Roundabout', icon: ICONS.roundabout, sub: w ? formatMoney(w.controlCost('roundabout')) : '', need: UNLOCK.roundabout, title: 'Click a junction to turn it into a roundabout' },
      { m: 'roundaboutLarge', label: 'Large roundabout', icon: ICONS.roundabout, sub: w ? formatMoney(w.controlCost('roundabout', true)) : '', need: UNLOCK.roundaboutLarge, title: 'Two-lane roundabout for busy junctions' },
      { m: 'yield', label: 'Yield signs', icon: ICONS.sign, sub: 'free', title: 'Side roads give way to the main road' },
      { m: 'stop', label: 'Stop signs', icon: ICONS.sign, sub: 'free', title: 'Side roads must stop before entering' },
      { m: 'allstop', label: 'All-way stop', icon: ICONS.sign, sub: 'free', title: 'Everybody stops; first come, first served' },
      { m: 'auto', label: 'Automatic', icon: ICONS.junction, sub: 'free', title: 'Remove signs and lights' },
    ];
    for (const md of modes) {
      const lk = md.need !== undefined && locked(md.need);
      host.append(
        subButton({
          label: md.label,
          icon: md.icon,
          sub: lk ? `🔒 ${md.need!.toLocaleString('en-US')} pop` : md.sub,
          title: md.title,
          active: junction.mode === md.m,
          locked: lk,
          onClick: () => {
            if (lk) {
              ui.toast(`${md.label} unlocks at ${md.need!.toLocaleString('en-US')} population`, 'warn');
              return;
            }
            junction.mode = md.m;
            sub(renderJunctionModes, 'junction');
          },
        }),
      );
    }
  };

  const renderSpeeds = (host: HTMLElement): void => {
    for (const s of [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130]) {
      host.append(
        subButton({
          label: `${s} km/h`,
          icon: ICONS.speed,
          active: speed.kmh === s,
          onClick: () => {
            speed.kmh = s;
            sub(renderSpeeds, 'speed');
          },
        }),
      );
    }
  };

  game.events.on('tool', (tool) => {
    if (tool === junction) sub(renderJunctionModes, 'junction');
    else if (tool === speed) sub(renderSpeeds, 'speed');
    else if (game.tools.subOwner() === 'junction' || game.tools.subOwner() === 'speed') sub(null);
  });

  ui.addToolButton({
    id: 'junction',
    label: 'Junctions',
    icon: ICONS.light,
    hotkey: 'J',
    title: 'Traffic lights, signs and roundabouts (J)',
    onClick: () => game.setTool(game.tool === junction ? null : junction),
    isActive: () => game.tool === junction,
  });
  ui.addToolButton({
    id: 'lanes',
    label: 'Lanes',
    icon: ICONS.lanes,
    hotkey: 'L',
    title: 'Lane manager: choose which lane goes where (L)',
    onClick: () => {
      if (game.tool === lane) {
        game.setTool(null);
        return;
      }
      const sel = game.tools.inspect.selection;
      lane.edit(sel?.kind === 'node' ? sel.tile : -1);
    },
    isActive: () => game.tool === lane,
  });
  ui.addToolButton({
    id: 'speed',
    label: 'Speed limits',
    icon: ICONS.speed,
    hotkey: 'K',
    title: 'Paint speed limits onto roads (K)',
    onClick: () => game.setTool(game.tool === speed ? null : speed),
    isActive: () => game.tool === speed,
  });

  game.events.on('openJunction', (tile) => openJunctionPanel(game, tile));
  setSegmentPanelHook(openSegmentPanel);
  return { lane, junction, speed };
}
