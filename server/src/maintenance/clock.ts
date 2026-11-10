/** Source of "now" for scheduling, windows and approval expiry. Adjustable so tests can move time. */
export interface Clock {
  now(): number;
}

export class AdjustableClock implements Clock {
  private offsetMs = 0;
  now(): number {
    return Date.now() + this.offsetMs;
  }
  /** Pretends it is `epochMs` from now on (time keeps flowing). */
  set(epochMs: number): void {
    this.offsetMs = epochMs - Date.now();
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
  reset(): void {
    this.offsetMs = 0;
  }
}
