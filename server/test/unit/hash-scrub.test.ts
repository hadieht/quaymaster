import { describe, expect, it } from 'vitest';
import { Scrubber, redactDeep } from '../../src/redaction/redact.js';

const HASH = 'f3b1c0a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1';

describe('plan hashes and image IDs are not secrets', () => {
  it('structured output keeps configHash / planHash / image IDs readable', () => {
    const out = redactDeep({
      configHash: HASH,
      planHash: HASH,
      fromImageId: `sha256:${HASH}`,
      services: [{ configHash: HASH, fromImageId: `sha256:${HASH}` }],
    }) as Record<string, unknown>;
    expect(out['configHash']).toBe(HASH);
    expect(out['planHash']).toBe(HASH);
    expect(out['fromImageId']).toBe(`sha256:${HASH}`);
    expect((out['services'] as { configHash: string }[])[0]?.configHash).toBe(HASH);
  });

  it('the known-value scrubber is not fed by them', () => {
    const sink = new Scrubber();
    redactDeep(
      { configHash: HASH, Labels: { 'com.docker.compose.config-hash': HASH } },
      { sink: (v) => sink.add(v) },
    );
    expect(sink.scrub(`hash ${HASH}`)).toBe(`hash ${HASH}`);
  });
});
