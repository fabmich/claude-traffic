import { intersectPolylines } from '../core/polyline';
import type { Connector, RoadNode } from './network';

/** Finds crossing and merging conflicts between all connector pairs of a node. */
export function computeConflicts(node: RoadNode): void {
  const cs = node.connectors;
  for (const c of cs) c.conflicts = [];
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i];
    for (let j = i + 1; j < cs.length; j++) {
      const b = cs[j];
      if (a.from === b.from) continue; // same queue, handled by car following
      if (a.to === b.to) {
        addPair(a, b, a.length, b.length, 'merge');
        continue;
      }
      const x = intersectPolylines(a.path, b.path);
      if (x) addPair(a, b, x.sa, x.sb, 'cross');
    }
  }
}

function addPair(a: Connector, b: Connector, sa: number, sb: number, kind: 'cross' | 'merge'): void {
  a.conflicts.push({ other: b, s: sa, sOther: sb, kind, yields: false });
  b.conflicts.push({ other: a, s: sb, sOther: sa, kind, yields: false });
}
