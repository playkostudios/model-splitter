import { bufferHash } from './caching';
import sharp from 'sharp';

import type { PackedResizeOption } from './external-types';
import type { ProcessedTextureList } from './internal-types';
import type { ILogger } from '@gltf-transform/core';

function resizeOptMatches(a: PackedResizeOption, b: PackedResizeOption) {
    return a === b || (a[0] === b[0] && a[1] === b[1]);
}

export async function resizeTexture(textures: ProcessedTextureList, origHash: string, resizeOpt: PackedResizeOption, save: boolean, inBuf: Buffer, logger: ILogger): Promise<[buffer: Buffer, hash: string, cached: boolean]> {
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

    // check if this resize operation has already been done
    for (let i = 0; i < textures.length; i++) {
        const [oInputs, oHash, oBuffer, _save] = textures[i];

        for (const [oResizeOpt, oOrigHash] of oInputs) {
            if (origHash === oOrigHash && resizeOptMatches(oResizeOpt, resizeOpt)) {
                if (save) {
                    textures[i][3] = true;
                }

                return [oBuffer, oHash, true];
            }
        }
    }

    if (resizeOpt === 'keep') {
        throw new Error('No match despite resizeOpt being "keep"');
    }

    // none of the inputs match, resize with sharp
    if (inSharp === undefined) {
        inSharp = sharp(inBuf);
    }

    const outBuf = await inSharp.resize(resizeOpt[0], resizeOpt[1]).toBuffer();
    const outHash = bufferHash(outBuf);

    // check if this resize operation has already been done, but
    // only the output matches
    for (let i = 0; i < textures.length; i++) {
        const [oInputs, oHash, oBuffer, _save] = textures[i];

        if (outHash === oHash) {
            if (save) {
                textures[i][3] = true;
            }

            logger.warn(`Resize option is equivalent to another resize option, but this was not detected before resizing. You probably have very similar textures being resized`);
            oInputs.push([resizeOpt, origHash]);
            return [oBuffer, oHash, false];
        }
    }

    // none of the outputs match, add to processed textures list
    textures.push([[[resizeOpt, origHash]], outHash, outBuf, save]);
    return [outBuf, outHash, false];
}