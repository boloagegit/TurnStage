import { sha256Hex } from '../../src/shared/sha256';
export { browserUuid } from '../../src/shared/uuid';

export function browserSha256(value: string): string { return sha256Hex(value); }
