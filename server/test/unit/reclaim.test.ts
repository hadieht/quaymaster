import { describe, expect, it } from 'vitest';
import { measureReclaim } from '../../src/docker/system.js';

/** Red-team RT3-06 (docs/reviews/03-cleanup-redteam.md): host-wide deltas must not be credited to a run. */
function usageWith(df: { v: number }) {
  return { measure: async () => ({ volumes: {}, images: {}, layersSize: df.v, volumesSize: 0 }) };
}

describe('measureReclaim', () => {
  it('reports 0 when nothing was removed, even if Docker usage dropped for other reasons meanwhile', async () => {
    const df = { v: 10_000_000_000 };
    const r = await measureReclaim(
      usageWith(df),
      async () => null,
      async () => {
        df.v -= 3_000_000_000; // an unrelated prune ran during the cleanup
        return { value: null, estimatedBytes: 0, maxBytes: 0 };
      },
    );
    expect(r.reclaim.dfDeltaBytes).toBe(3_000_000_000); // still shown as context
    expect(r.reclaim.reclaimedBytes).toBe(0);
    expect(r.reclaim.caveat).toMatch(/other activity/);
  });

  it('caps the headline at what the removed items occupied', async () => {
    const df = { v: 10_000_000_000 };
    const r = await measureReclaim(
      usageWith(df),
      async () => null,
      async () => {
        df.v -= 2_000_000_000;
        return { value: null, estimatedBytes: 400, maxBytes: 500_000_000 };
      },
    );
    expect(r.reclaim.reclaimedBytes).toBe(500_000_000);
  });

  it('flags a measured figure below the estimate (usage grew meanwhile) instead of presenting it silently', async () => {
    const df = { v: 10_000_000_000 };
    const r = await measureReclaim(
      usageWith(df),
      async () => null,
      async () => {
        df.v = df.v - 500_000_000 + 2_000_000_000; // removed 500 MB while a 2 GB pull finished
        return { value: null, estimatedBytes: 500_000_000, maxBytes: 500_000_000 };
      },
    );
    expect(r.reclaim.reclaimedBytes).toBe(0);
    expect(r.reclaim.caveat).toMatch(/lower than the estimate/);
  });

  it('without a cap (unknown size) the df delta is reported unchanged', async () => {
    const df = { v: 1000 };
    const r = await measureReclaim(
      usageWith(df),
      async () => null,
      async () => {
        df.v -= 600;
        return { value: null, estimatedBytes: 600 };
      },
    );
    expect(r.reclaim).toMatchObject({ reclaimedBytes: 600, basis: 'df' });
  });
});
