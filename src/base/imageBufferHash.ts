import { bufferHash } from './bufferHash.js';
import { type FileSignature, bufferHasMagic } from './bufferHasMagic.js';

const FORMATS = new Map<string, FileSignature>([
    ['bmp', [
        [[0, new Uint8Array([0x42,0x4D])]],
    ]],
    ['gif', [
        [[0, new Uint8Array([0x47,0x49,0x46,0x38,0x37,0x61])]],
        [[0, new Uint8Array([0x47,0x49,0x46,0x38,0x39,0x61])]],
    ]],
    ['png', [
        [[0, new Uint8Array([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])]],
    ]],
    ['jpg', [
        [[0, new Uint8Array([0xFF,0x4F,0xFF,0x51])]],
        [[0, new Uint8Array([0xFF,0xD8,0xFF,0xDB])]],
        [[0, new Uint8Array([0xFF,0xD8,0xFF,0xE0])]],
        [[0, new Uint8Array([0xFF,0xD8,0xFF,0xEE])]],
        [[0, new Uint8Array([0x00,0x00,0x00,0x0C,0x6A,0x50,0x20,0x20,0x0D,0x0A,0x87,0x0A])]],
        [[0, new Uint8Array([0xFF,0xD8,0xFF,0xE1])], [6, new Uint8Array([0x45,0x78,0x69,0x66,0x00,0x00])]],
    ]],
    ['ktx2', [
        [[0, new Uint8Array([0xAB,0x4B,0x54,0x58,0x20,0x32,0x30,0xBB,0x0D,0x0A,0x1A,0x0A])]],
    ]],
]);

export function imageBufferHash(buffer: Uint8Array) {
    let hash = bufferHash(buffer);

    for (const [fileExt, signature] of FORMATS) {
        if (bufferHasMagic(buffer, signature)) {
            hash = `${hash}.${fileExt}`;
            break;
        }
    }

    return hash;
}
