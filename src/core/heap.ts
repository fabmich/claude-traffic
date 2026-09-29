/**
 * Binary min-heap of integer values keyed by float priorities.
 * Duplicate values are allowed (use lazy deletion in searches).
 */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;
  /** Key of the value returned by the last pop(). */
  lastKey = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  push(val: number, key: number): void {
    if (this.size === this.keys.length) this.grow();
    let i = this.size++;
    const keys = this.keys;
    const vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    this.lastKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const k = keys[n];
      const v = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }

  peekKey(): number {
    return this.keys[0];
  }

  private grow(): void {
    const k = new Float64Array(this.keys.length * 2);
    const v = new Int32Array(this.vals.length * 2);
    k.set(this.keys);
    v.set(this.vals);
    this.keys = k;
    this.vals = v;
  }
}
