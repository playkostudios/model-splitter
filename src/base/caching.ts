import { createHash } from 'node:crypto';
import { dataUriToBuffer } from 'data-uri-to-buffer';

import type { IBuffer } from 'babylonjs-gltf2interface';
import type { PackedResizeOption } from './external-types';
import type { ProcessedTextureList } from './internal-types';

export function parseBuffer(parsedBuffers: Array<Buffer>, buffer: IBuffer): Buffer {
    // validate buffer
    if (buffer === undefined) {
        throw new Error('Unexpected missing buffer');
    }

    // check if already parsed or parse
    if (typeof buffer.uri === 'number') {
        // already parsed
        return parsedBuffers[buffer.uri];
    } else if (typeof buffer.uri === 'string') {
        // data URI
        const bufParsed = dataUriToBuffer(buffer.uri);
        const pBufIdx = parsedBuffers.length;
        parsedBuffers.push(bufParsed);
        // HACK replace uri with index for parsedBuffers
        (buffer.uri as unknown as number) = pBufIdx;
        return bufParsed;
    } else {
        throw new Error('Unexpected buffer URI value');
    }
}

export function bufferHash(buffer: Buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

export function getProcessedTexture(textures: ProcessedTextureList, origHash: string, hash: string, buffer: Buffer, resizeOpt: PackedResizeOption): Buffer {
    for (let i = 0; i < textures.length; i++) {
        const texture = textures[i];
        if (hash === texture[1]) {
            return texture[2];
        }
    }

    textures.push([[[resizeOpt, origHash]], hash, buffer, false]);
    return buffer;
}