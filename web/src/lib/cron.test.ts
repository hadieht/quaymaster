import { describe, expect, it } from 'vitest';
import { describeCron } from './cron';

describe('describeCron', () => {
  it('explains common schedules in plain language', () => {
    expect(describeCron('0 3 * * *')).toBe('At 03:00 every day');
    expect(describeCron('30 2 * * 1-5')).toBe('At 02:30 on Monday to Friday');
    expect(describeCron('0 4 * * 0')).toBe('At 04:00 on Sunday');
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeCron('0 5 1 * *')).toBe('At 05:00 on day 1 of the month');
  });
  it('returns null for what it cannot explain', () => {
    expect(describeCron('nonsense')).toBeNull();
    expect(describeCron('0 3 * * MON')).toBeNull();
  });
});
