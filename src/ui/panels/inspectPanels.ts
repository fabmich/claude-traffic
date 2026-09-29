import { TILE } from '../../config';
import type { Game } from '../../game/Game';
import type { Selection } from '../../input/tools/InspectTool';
import { ROAD_TYPES } from '../../roads/roadTypes';
import { VKind } from '../../sim/params';
import type { Vehicle } from '../../sim/vehicle';
import { h } from '../dom';
import { openBuildingPanel } from './buildingPanel';
import { kvList, makePanel } from './panel';

const KIND_NAMES = ['Car', 'Truck', 'Bus'];

function vehicleStatus(game: Game, v: Vehicle): string {
  const world = game.world!;
  if (v.conn) return 'Crossing a junction';
  if (v.layer === 1) return 'On a bridge';
  if (v.layer === -1) return 'In a tunnel';
  if (v.v < 0.5 && v.nextConn) {
    const ctrl = world.traffic.control(v.nextConn.node);
    const light = ctrl.lightFor(v.nextConn);
    if (light === 'red') return `Waiting at a red light (${Math.round(v.waitTime)} s)`;
    if (v.granted) return 'Waiting in a queue';
    return `Giving way (${Math.round(v.waitTime)} s)`;
  }
  if (!v.nextConn && v.routeIdx < v.route.length - 1) return 'Changing lanes for the next turn';
  if (v.lat !== 0) return 'Changing lanes';
  return 'Driving';
}

/** Live info panel for a selected vehicle; the camera can follow it. */
export function openVehiclePanel(game: Game, v: Vehicle): void {
  let follow = false;
  const handle = makePanel(`${KIND_NAMES[v.kind]} #${v.id}`, () => game.tools.inspect.select(null));
  const kv = kvList(['Status', 'Speed', 'Speed limit', 'Driven', 'Trip time', 'Trip', 'Route legs left']);
  const followBtn = h('button', { class: 'btn small', type: 'button' }, 'Follow');
  followBtn.addEventListener('click', () => {
    follow = !follow;
    followBtn.classList.toggle('primary', follow);
  });
  handle.body.append(kv.el, h('div', { class: 'row' }, followBtn));
  handle.body.append(h('p', { class: 'hint' }, 'The blue line shows the route this driver chose. Drivers pick the fastest route using speed limits, live congestion and waiting times at junctions.'));
  const refresh = (): void => {
    const world = game.world;
    if (!world || v.listIndex < 0) {
      kv.set(['Arrived or removed', '-', '-', '-', '-', '-', '-']);
      return;
    }
    const limit = v.lane ? v.lane.speedLimit : v.conn ? v.conn.maxSpeed : 0;
    kv.set([
      vehicleStatus(game, v),
      `${Math.round(v.v * 3.6)} km/h`,
      `${Math.round(limit * 3.6)} km/h`,
      `${(v.distanceDriven / 1000).toFixed(2)} km`,
      `${Math.round(world.traffic.time - v.spawnTime)} s`,
      typeof v.tripData === 'string' ? v.tripData : v.dest?.outside ? 'Leaving the city' : v.kind === VKind.Bus ? 'Bus route' : 'Test trip',
      String(Math.max(0, v.route.length - v.routeIdx - 1)),
    ]);
    if (follow) {
      const cam = game.renderer.camera;
      cam.x += (v.x - cam.x) * 0.25;
      cam.y += (v.y - cam.y) * 0.25;
    }
  };
  refresh();
  const timer = window.setInterval(refresh, 150);
  handle.el.addEventListener('closed', () => window.clearInterval(timer));
  game.ui.openPanel(handle.el, 'inspect');
}

/** Information about a junction (full editor comes with the junction tools). */
export function openNodeInfoPanel(game: Game, tile: number): void {
  const world = game.world!;
  const handle = makePanel('Junction', () => game.tools.inspect.select(null));
  const kv = kvList(['Control', 'Roads', 'Vehicles passed', 'Waiting now']);
  handle.body.append(kv.el);
  const refresh = (): void => {
    const net = world.network;
    const rb = net.roundabouts.get(tile);
    const nodes = rb ? rb.nodes : [net.nodeByTile.get(tile)].filter((n): n is NonNullable<typeof n> => !!n);
    if (nodes.length === 0) {
      kv.set(['Removed', '-', '-', '-']);
      return;
    }
    const ctrls = nodes.map((n) => world.traffic.control(n));
    const kind = ctrls[0].kind;
    const names: Record<string, string> = { auto: 'Automatic right of way', priority: 'Priority signs', allstop: 'All-way stop', signals: 'Traffic lights', roundabout: 'Roundabout' };
    let waiting = 0;
    for (const n of nodes) for (const a of n.arms) for (const l of a.ins) for (const v of l.vehicles) if (v.v < 0.5 && l.length - v.s < 60) waiting++;
    kv.set([names[kind] ?? kind, String(rb ? nodes.length : nodes[0].arms.length), String(ctrls.reduce((s, c) => s + c.passed, 0)), String(waiting)]);
  };
  refresh();
  const timer = window.setInterval(refresh, 300);
  handle.el.addEventListener('closed', () => window.clearInterval(timer));
  game.ui.openPanel(handle.el, 'inspect');
}

export function openSegmentInfoPanel(game: Game, key: string): void {
  const world = game.world!;
  const handle = makePanel('Road', () => game.tools.inspect.select(null));
  const kv = kvList(['Type', 'Lanes', 'Speed limit', 'Length', 'Vehicles', 'Average speed']);
  handle.body.append(kv.el);
  const refresh = (): void => {
    const seg = world.network.segByKey.get(key);
    if (!seg) {
      kv.set(['Removed', '-', '-', '-', '-', '-']);
      return;
    }
    const lanes = seg.lanes;
    let n = 0;
    let sum = 0;
    for (const l of lanes)
      for (const v of l.vehicles) {
        n++;
        sum += v.v;
      }
    kv.set([
      ROAD_TYPES[seg.type.id].name,
      seg.backward.length && seg.forward.length ? `${seg.forward.length} + ${seg.backward.length}` : `${lanes.length} (one-way)`,
      `${Math.round(seg.speedLimit * 3.6)} km/h`,
      `${Math.round(seg.length)} m (${(seg.length / TILE).toFixed(1)} tiles)`,
      String(n),
      n ? `${Math.round((sum / n) * 3.6)} km/h` : '-',
    ]);
  };
  refresh();
  const timer = window.setInterval(refresh, 400);
  handle.el.addEventListener('closed', () => window.clearInterval(timer));
  game.ui.openPanel(handle.el, 'inspect');
}

export function openSelectionPanel(game: Game, sel: Selection): void {
  if (!sel) {
    game.ui.closePanels('inspect');
    return;
  }
  if (sel.kind === 'vehicle') openVehiclePanel(game, sel.vehicle);
  else if (sel.kind === 'node') game.events.emit('openJunction', sel.tile);
  else if (sel.kind === 'building') openBuildingPanel(game, sel.id);
  else openSegmentPanelHook(game, sel.key);
}

/** Replaced by the traffic tools module with the editable segment panel. */
export let openSegmentPanelHook: (game: Game, key: string) => void = openSegmentInfoPanel;
export function setSegmentPanelHook(fn: (game: Game, key: string) => void): void {
  openSegmentPanelHook = fn;
}
