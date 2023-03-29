import { createHash } from 'node:crypto';

export function bufferHash(buffer: Uint8Array) {
    return createHash('sha256').update(buffer).digest('hex');
}
