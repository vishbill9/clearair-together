import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** AES-256-GCM. Each image gets a fresh 96-bit IV; the auth tag detects tampering. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes.');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { ciphertext, iv, authTag: c.getAuthTag() };
}

export function open(key: Buffer, s: Sealed, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, s.iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(s.authTag);
  return Buffer.concat([d.update(s.ciphertext), d.final()]);
}
