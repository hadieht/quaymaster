import { z } from 'zod';
import type { Severity } from '@quaymaster/shared';
import { AppError } from '../../util/errors.js';
import { validateOutboundUrl } from '../outbound.js';

/** A URL that passes the outbound policy (scheme, no userinfo, no metadata/unspecified IPs). */
export const outboundUrl = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((v, ctx) => {
    try {
      validateOutboundUrl(v);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof AppError ? e.message : 'Invalid URL' });
    }
  });

export const SEVERITY_LABEL: Record<Severity, string> = {
  info: 'INFO',
  warning: 'WARNING',
  critical: 'CRITICAL',
};
