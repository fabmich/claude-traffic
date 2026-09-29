import { Zone } from './zones';

/** A building that can grow on zoned land. `w` runs along the road, `d` away from it. */
export interface BuildingTemplate {
  key: string;
  name: string;
  zone: number;
  w: number;
  d: number;
  /** Residents (R) or jobs (C/I/F) per level 1..3. */
  capacity: [number, number, number];
  /** Relative chance of being picked when it fits. */
  weight: number;
  /** Lowest demand at which this template appears (bigger buildings need more demand). */
  minDemand: number;
}

export const TEMPLATES: readonly BuildingTemplate[] = [
  { key: 'house', name: 'House', zone: Zone.Residential, w: 1, d: 1, capacity: [4, 7, 12], weight: 6, minDemand: 0 },
  { key: 'townhouses', name: 'Townhouses', zone: Zone.Residential, w: 2, d: 1, capacity: [9, 16, 26], weight: 3, minDemand: 0.25 },
  { key: 'apartments', name: 'Apartments', zone: Zone.Residential, w: 2, d: 2, capacity: [24, 44, 72], weight: 2, minDemand: 0.45 },
  { key: 'shop', name: 'Corner shop', zone: Zone.Commercial, w: 1, d: 1, capacity: [4, 6, 9], weight: 5, minDemand: 0 },
  { key: 'store', name: 'Store', zone: Zone.Commercial, w: 2, d: 1, capacity: [8, 13, 20], weight: 3, minDemand: 0.2 },
  { key: 'mall', name: 'Shopping centre', zone: Zone.Commercial, w: 2, d: 2, capacity: [18, 30, 46], weight: 1.5, minDemand: 0.45 },
  { key: 'workshop', name: 'Workshop', zone: Zone.Industrial, w: 1, d: 2, capacity: [6, 9, 14], weight: 3, minDemand: 0 },
  { key: 'factory', name: 'Factory', zone: Zone.Industrial, w: 2, d: 2, capacity: [14, 22, 34], weight: 4, minDemand: 0.1 },
  { key: 'plant', name: 'Industrial plant', zone: Zone.Industrial, w: 3, d: 2, capacity: [24, 38, 56], weight: 1.5, minDemand: 0.4 },
  { key: 'farm', name: 'Farm', zone: Zone.Farming, w: 2, d: 2, capacity: [4, 6, 9], weight: 4, minDemand: 0 },
  { key: 'bigfarm', name: 'Large farm', zone: Zone.Farming, w: 3, d: 3, capacity: [8, 12, 18], weight: 2, minDemand: 0.2 },
];

export const templatesFor = (zone: number): BuildingTemplate[] => TEMPLATES.filter((t) => t.zone === zone);
