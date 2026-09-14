import { describe, expect, it } from 'vitest';
import { browserSha256, browserUuid } from '../web/src/browserCrypto';

describe('HTTP-compatible browser cryptography', () => {
  it('makes a version 4 UUID when randomUUID is unavailable', () => {
    const source = { getRandomValues: (bytes: Uint8Array) => { bytes.set(Array.from({ length: 16 }, (_, index) => index)); return bytes; } };
    expect(browserUuid(source as Crypto)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('hashes suite revisions without crypto.subtle', () => {
    expect(browserSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
