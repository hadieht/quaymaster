import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for secrets at rest (spec section 5, RT-37).
 *
 * - key: HKDF-SHA256 derived from QM_SECRET_KEY (never stored)
 * - IV: random 96 bits per message
 * - AAD: `table:column:rowId`, so ciphertexts cannot be swapped between rows
 * - format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url); keyId allows future key rotation
 */
export class SecretBox {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(masterKey: Buffer) {
    if (masterKey.length < 32) throw new Error('secret key must be at least 32 bytes');
    this.key = Buffer.from(
      hkdfSync('sha256', masterKey, Buffer.from('quaymaster'), Buffer.from('secrets-v1'), 32),
    );
    this.keyId = createHash('sha256').update(this.key).digest('hex').slice(0, 8);
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return [
      'v1',
      this.keyId,
      iv.toString('base64url'),
      c.getAuthTag().toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string, aad: string): string {
    const parts = payload.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('unsupported ciphertext format');
    const [, keyId, iv, tag, ct] = parts as [string, string, string, string, string];
    if (keyId !== this.keyId) throw new Error('ciphertext was encrypted with a different QM_SECRET_KEY');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }
}

/** HMAC-free helper used for non-reversible fingerprints (e.g. failed-login usernames in the audit log). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
