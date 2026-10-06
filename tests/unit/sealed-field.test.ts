import { describe, expect, it } from 'vitest';
import {
  SealedFieldError, lastFour, maskIdentifier, openField, sameIdentifier,
  sealField, sealingKeyConfigured,
} from '../../packages/integrations/src/sealed-field';

const KEY = { FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') } as NodeJS.ProcessEnv;
const OTHER_KEY = { FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') } as NodeJS.ProcessEnv;
const ID = '8301205832086';

describe('sealed identity and bank numbers', () => {
  it('round-trips a value', () => {
    const sealed = sealField(ID, 'resident:abc', KEY);
    expect(openField(sealed, 'resident:abc', KEY)).toBe(ID);
  });

  it('does not leave the plaintext visible in the ciphertext', () => {
    const sealed = sealField(ID, 'resident:abc', KEY);
    expect(sealed.toString('latin1')).not.toContain(ID);
    expect(sealed.toString('latin1')).not.toContain('5832086');
  });

  it('produces different ciphertext each time, so equal values are not linkable', () => {
    const a = sealField(ID, 'resident:abc', KEY);
    const b = sealField(ID, 'resident:abc', KEY);
    expect(a.equals(b)).toBe(false);
  });

  it('refuses a value sealed under a different key', () => {
    const sealed = sealField(ID, 'resident:abc', KEY);
    expect(() => openField(sealed, 'resident:abc', OTHER_KEY)).toThrow(SealedFieldError);
  });

  // The binding that stops a sealed number being moved between records.
  it('refuses a value lifted into another record', () => {
    const sealed = sealField(ID, 'resident:abc', KEY);
    expect(() => openField(sealed, 'resident:xyz', KEY)).toThrow(/different record|authentication/i);
  });

  it('refuses a tampered value rather than returning something else', () => {
    const sealed = sealField(ID, 'resident:abc', KEY);
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => openField(sealed, 'resident:abc', KEY)).toThrow(SealedFieldError);
  });

  it('fails loudly when no key is configured', () => {
    expect(() => sealField(ID, 'resident:abc', {} as NodeJS.ProcessEnv)).toThrow(/FIELD_ENCRYPTION_KEY/);
    expect(sealingKeyConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(sealingKeyConfigured(KEY)).toBe(true);
  });

  it('rejects a key of the wrong length instead of padding it', () => {
    const short = { FIELD_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') } as NodeJS.ProcessEnv;
    expect(() => sealField(ID, 'resident:abc', short)).toThrow(/32 bytes/);
  });

  it('masks and shortens for display without exposing the body', () => {
    expect(lastFour(ID)).toBe('2086');
    expect(maskIdentifier(ID)).toBe('•••••••••2086');
    expect(maskIdentifier('123')).toBe('•••');
  });

  it('compares identifiers ignoring spacing', () => {
    expect(sameIdentifier('830120 5832 086', ID)).toBe(true);
    expect(sameIdentifier('830120 5832 087', ID)).toBe(false);
  });
});
