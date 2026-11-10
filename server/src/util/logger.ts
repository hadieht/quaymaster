import pino, { type Logger } from 'pino';
import { globalScrubber, redactText } from '../redaction/redact.js';

/** Paths pino masks structurally, in addition to the text scrubbing below. */
export const LOG_REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-qm-csrf"]',
  'env',
  '*.env',
  'Env',
  '*.Env',
];

/**
 * Creates the application logger. Every message and string field is passed through the text
 * redaction rules and the known-value scrubber, so secrets that appear in interpolated strings
 * (which path-based redaction cannot see) are masked too.
 */
export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  const clean = (s: string): string => redactText(globalScrubber.scrub(s));
  return pino(
    {
      level,
      base: { app: 'quaymaster' },
      redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
      formatters: {
        log(obj: Record<string, unknown>) {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? clean(v) : v;
          return out;
        },
      },
      hooks: {
        logMethod(args, method) {
          const mapped = args.map((a) => (typeof a === 'string' ? clean(a) : a)) as typeof args;
          // err objects: scrub message/stack in place on a copy
          const first = mapped[0];
          if (first && typeof first === 'object' && 'err' in first && first.err instanceof Error) {
            const e = first.err;
            const copy = Object.assign(Object.create(Object.getPrototypeOf(e)) as Error, e, {
              message: clean(e.message),
              stack: e.stack ? clean(e.stack) : undefined,
            });
            mapped[0] = { ...first, err: copy } as never;
          }
          return method.apply(this, mapped);
        },
      },
    },
    destination,
  );
}

export type { Logger };
