import { UNLOCK } from '../config';
import { formatInt, formatMoney } from '../core/math';
import type { Game } from '../game/Game';
import { LineTool, StopTool } from '../input/tools/transitTools';
import { drawLines, drawStops } from '../render/transitDraw';
import { TRANSIT, type Line, type Stop } from '../transit/Transit';
import { h, icon } from './dom';
import { ICONS } from './icons';
import { kvList, makePanel } from './panels/panel';
import { subButton } from './toolbarSetup';

export interface TransitToolset {
  stop: StopTool;
  line: LineTool;
}

function minutes(sec: number): string {
  if (!isFinite(sec)) return '-';
  return sec < 90 ? `${Math.round(sec)} s` : `${(sec / 60).toFixed(1)} min`;
}

/** Bus stops, bus lines, their panels, the line overlay and the bus share readout. */
export function setupTransitUI(game: Game): TransitToolset {
  const ui = game.ui;
  const stopTool = new StopTool(game);
  const lineTool = new LineTool(game);
  const sub = game.tools.showSub;
  let openLine: Line | null = null;
  let openStop: Stop | null = null;
  const locked = (): string | null => {
    const w = game.world;
    if (!w || w.sandbox || ui.unlockPopulation >= UNLOCK.buses) return null;
    return `Buses unlock at ${UNLOCK.buses.toLocaleString('en-US')} population`;
  };

  // ------------------------------------------------------------ toolbar
  const renderTransit = (host: HTMLElement): void => {
    const world = game.world;
    if (!world) return;
    host.append(
      subButton({
        label: 'Bus stop',
        icon: ICONS.bus,
        sub: formatMoney(TRANSIT.stopCost),
        title: 'Place stops on the side of streets. Each stop serves one direction of travel.',
        active: game.tool === stopTool,
        onClick: () => {
          game.setTool(game.tool === stopTool ? null : stopTool);
          sub(renderTransit, 'transit');
        },
      }),
      subButton({
        label: game.tool === lineTool && !lineTool.editing ? `New line (${lineTool.stops.length})` : 'New line',
        icon: ICONS.lanes,
        sub: 'click stops',
        title: 'Click stops (or street sides) in order; click the first stop again or press Enter to finish',
        active: game.tool === lineTool && !lineTool.editing,
        onClick: () => {
          if (game.tool === lineTool) lineTool.finish();
          else lineTool.begin(null);
          sub(renderTransit, 'transit');
        },
      }),
    );
    for (const line of world.transit.lines) {
      host.append(
        subButton({
          label: line.name,
          html: `<svg viewBox="0 0 28 24" width="28" height="24"><rect x="3" y="4" width="22" height="16" rx="5" fill="${line.color}"/><path d="M9 12h10" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>`,
          sub: `${line.buses.size} bus${line.buses.size === 1 ? '' : 'es'}`,
          title: `${line.name}: ${line.stops.length} stops`,
          active: openLine === line,
          onClick: () => openLinePanel(line),
        }),
      );
    }
  };
  game.events.on('tool', (tool) => {
    if (tool === stopTool || tool === lineTool) sub(renderTransit, 'transit');
  });
  game.events.on('lineDraft', () => {
    if (game.tools.subOwner() === 'transit') sub(renderTransit, 'transit');
  });
  ui.addToolButton({
    id: 'transit',
    label: 'Transit',
    icon: ICONS.bus,
    hotkey: 'T',
    title: 'Bus stops and bus lines (T)',
    onClick: () => {
      if (game.tools.subOwner() === 'transit' && game.tool !== stopTool && game.tool !== lineTool) {
        sub(null);
        return;
      }
      if (game.tool === stopTool || game.tool === lineTool) {
        game.setTool(null);
        sub(null);
        return;
      }
      game.setTool(stopTool);
      sub(renderTransit, 'transit');
    },
    isActive: () => game.tool === stopTool || game.tool === lineTool || game.tools.subOwner() === 'transit',
    isLocked: locked,
  });

  // ------------------------------------------------------------ line panel
  const openLinePanel = (line: Line): void => {
    const world = game.world;
    if (!world) return;
    openLine = line;
    const transit = world.transit;
    const handle = makePanel(line.name, () => ui.closePanels('line'));
    const name = h('input', { class: 'input', value: line.name, maxlength: 24 }) as HTMLInputElement;
    name.addEventListener('change', () => {
      line.name = name.value.trim() || line.name;
      handle.title.textContent = line.name;
      if (game.tools.subOwner() === 'transit') sub(renderTransit, 'transit');
    });
    const colors = h('div', { class: 'color-row' });
    const renderColors = (): void => {
      colors.replaceChildren(
        ...TRANSIT.colors.map((c) => {
          const b = h('button', { class: `color-chip${c === line.color ? ' on' : ''}`, type: 'button', title: c, style: { background: c } });
          b.addEventListener('click', () => {
            line.color = c;
            for (const v of line.buses) v.color = c;
            renderColors();
          });
          return b;
        }),
      );
    };
    renderColors();
    const count = h('span', { class: 'count' });
    const minus = h('button', { class: 'btn small', type: 'button' }, '−');
    const plus = h('button', { class: 'btn small', type: 'button' }, '+');
    minus.addEventListener('click', () => transit.setBusCount(line, line.target - 1));
    plus.addEventListener('click', () => transit.setBusCount(line, line.target + 1));
    const kv = kvList(['Stops', 'Round trip', 'A bus every', 'Riders today', 'Riders yesterday', 'On board now', 'Waiting at stops', 'Upkeep']);
    const warn = h('div', { class: 'warn-line' });
    const edit = h('button', { class: 'btn small', type: 'button' }, 'Change stops');
    edit.addEventListener('click', () => {
      ui.closePanels('line');
      lineTool.begin(line);
      sub(renderTransit, 'transit');
    });
    const del = h('button', { class: 'btn small danger', type: 'button' }, 'Delete line');
    del.addEventListener('click', () => {
      transit.deleteLine(line);
      ui.closePanels('line');
      if (game.tools.subOwner() === 'transit') sub(renderTransit, 'transit');
    });
    handle.body.append(
      h('div', { class: 'section-title' }, 'Name and colour'),
      name,
      colors,
      h('div', { class: 'section-title' }, 'Buses'),
      h('div', { class: 'row bus-count' }, minus, count, plus),
      kv.el,
      warn,
      h('p', { class: 'hint' }, 'More buses mean shorter waits, so more people leave their car at home. People walk up to about 9 tiles to a stop and may change lines once.'),
      h('div', { class: 'row' }, edit, del),
    );
    const refresh = (): void => {
      if (!transit.lines.includes(line)) {
        warn.textContent = 'This line was deleted.';
        return;
      }
      count.textContent = `${line.buses.size} / ${line.target} bus${line.target === 1 ? '' : 'es'}`;
      let onBoard = 0;
      for (const v of line.buses) onBoard += transit.busInfo(v)?.riders ?? 0;
      let waiting = 0;
      for (const s of line.stops) for (const p of s.waiting) if (p.current.line === line) waiting++;
      kv.set([
        String(line.stops.length),
        minutes(line.cycle),
        minutes(line.headway),
        formatInt(line.riders),
        formatInt(line.ridersYesterday),
        String(onBoard),
        String(waiting),
        `${formatMoney(line.target * TRANSIT.busUpkeep)}/day`,
      ]);
      warn.textContent = line.broken ? 'Buses cannot reach every stop. Check the dashed parts of the route.' : line.stops.some((s) => !s.valid) ? 'Some stops lost their road.' : '';
    };
    refresh();
    const timer = window.setInterval(refresh, 400);
    handle.el.addEventListener('closed', () => {
      window.clearInterval(timer);
      if (openLine === line) openLine = null;
      if (game.tools.subOwner() === 'transit') sub(renderTransit, 'transit');
    });
    ui.openPanel(handle.el, 'line');
    if (game.tools.subOwner() === 'transit') sub(renderTransit, 'transit');
  };
  game.events.on('openLine', (line) => {
    sub(renderTransit, 'transit');
    openLinePanel(line);
  });

  // ------------------------------------------------------------ stop panel
  const openStopPanel = (stop: Stop): void => {
    const world = game.world;
    if (!world) return;
    openStop = stop;
    const transit = world.transit;
    const handle = makePanel(stop.name, () => ui.closePanels('stop'));
    const kv = kvList(['Lines', 'Waiting', 'Boardings today', 'Boardings yesterday']);
    const chips = h('div', { class: 'line-chips' });
    const del = h('button', { class: 'btn small danger', type: 'button' }, 'Delete stop');
    del.addEventListener('click', () => {
      transit.removeStop(stop);
      ui.closePanels('stop');
    });
    handle.body.append(kv.el, chips, h('div', { class: 'row' }, del));
    let lastLines = '';
    const refresh = (): void => {
      if (!transit.stops.includes(stop)) {
        kv.set(['-', '-', '-', '-']);
        return;
      }
      kv.set([String(stop.lines.length || 'none'), String(stop.waiting.length), formatInt(stop.boardings), formatInt(stop.boardingsYesterday)]);
      const key = stop.lines.map((l) => l.id).join(',');
      if (key !== lastLines) {
        lastLines = key;
        chips.replaceChildren(
          ...stop.lines.map((l) => {
            const b = h('button', { class: 'line-chip', type: 'button', style: { background: l.color } }, l.name);
            b.addEventListener('click', () => openLinePanel(l));
            return b;
          }),
        );
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 400);
    handle.el.addEventListener('closed', () => {
      window.clearInterval(timer);
      if (openStop === stop) openStop = null;
    });
    ui.openPanel(handle.el, 'stop');
  };
  game.events.on('openStop', (stop) => openStopPanel(stop));

  // ------------------------------------------------------------ drawing
  game.renderer.upperDrawers.push((ctx, r) => {
    if (game.world) drawStops(ctx, r, game.world.transit, openStop);
  });
  game.renderer.overlayDrawers.unshift((ctx, r) => {
    const world = game.world;
    if (!world || game.tool === stopTool || game.tool === lineTool) return;
    if (game.overlay === 'lines' || openLine) drawLines(ctx, r, world.transit.lines, openLine);
  });

  // ------------------------------------------------------------ bus share in the top bar
  const shareEl = h('span', { class: 'value' }, '0%');
  const shareGroup = h('div', { class: 'tb-group stat hidden', title: 'Share of trips made by bus today' }, icon(ICONS.bus), shareEl);
  ui.addExtra(shareGroup);
  ui.refreshers.push(() => {
    const world = game.world;
    if (!world) return;
    const has = world.transit.lines.length > 0;
    shareGroup.classList.toggle('hidden', !has);
    if (!has) return;
    const m = world.city.modeCounts;
    const total = m.car + m.walk + m.bus;
    shareEl.textContent = `${total ? Math.round((m.bus / total) * 100) : 0}%`;
  });

  ui.orderToolbar(['road', 'zone', 'bulldoze', 'junction', 'lanes', 'speed', 'transit', 'views', 'city']);
  return { stop: stopTool, line: lineTool };
}
