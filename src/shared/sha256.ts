import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** Synchronous SHA-256 shared by the Node extension, CLI, and browser build. */
export function sha256Hex(value: string | Uint8Array): string {
  return bytesToHex(nobleSha256(typeof value === 'string' ? utf8ToBytes(value) : value));
}
