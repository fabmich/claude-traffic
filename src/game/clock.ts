import { DAY_SECONDS, START_HOUR } from '../config';

/** Game clock measured in simulated seconds since day 1, 00:00. */
export class Clock {
  time = (START_HOUR / 24) * DAY_SECONDS;

  advance(dt: number): void {
    this.time += dt;
  }

  /** 1-based day number. */
  get day(): number {
    return Math.floor(this.time / DAY_SECONDS) + 1;
  }

  /** Fractional hour of day in [0, 24). */
  get hour(): number {
    return ((this.time % DAY_SECONDS) / DAY_SECONDS) * 24;
  }

  /** Simulated seconds per game hour. */
  static get HOUR(): number {
    return DAY_SECONDS / 24;
  }

  /** Light level 0 (night) .. 1 (day) used for the night tint. */
  get daylight(): number {
    const h = this.hour;
    if (h >= 7 && h <= 18) return 1;
    if (h <= 5 || h >= 20.5) return 0;
    if (h < 7) return (h - 5) / 2;
    return 1 - (h - 18) / 2.5;
  }

  format(): string {
    const h = this.hour;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `Day ${this.day}  ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
}
