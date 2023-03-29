import { bufferHash } from './bufferHash';
import sharp from 'sharp';

import type { PackedResizeOption } from './external-types';

export async function resizeTexture(resizeOpt: PackedResizeOption, inBuf: Uint8Array, inHash: string): Promise<[buffer: Uint8Array, hash: string]> {
    // normalize to 'keep', or percentage-based resize operations to absolute
    // dimensions
    let inSharp: sharp.Sharp | undefined;
    if (Array.isArray(resizeOpt) && resizeOpt[2] === '%') {
        if (resizeOpt[0] === 100 && resizeOpt[1] === 100) {
            resizeOpt = 'keep';
        } else {
            inSharp = sharp(inBuf);
            const inMeta = await inSharp.metadata();
            if (inMeta.width === undefined || inMeta.height === undefined) {
                throw new Error('Unexpected missing width/height in input image metadata; needed for percentage-based resizing');
            }

            resizeOpt = [
                Math.round(inMeta.width  * resizeOpt[0] / 100),
                Math.round(inMeta.height * resizeOpt[1] / 100)
            ];

            if (resizeOpt[0] === inMeta.width && resizeOpt[1] === inMeta.height) {
                resizeOpt = 'keep';
            }
        }
    }

    // do nothing if "keep"
    if (resizeOpt === 'keep') {
        return [inBuf, inHash];
    }

    // resize with sharp
    if (inSharp === undefined) {
        inSharp = sharp(inBuf);
    }

    const outBuf = await inSharp.resize(resizeOpt[0], resizeOpt[1]).toBuffer();
    return [outBuf, bufferHash(outBuf)];
}