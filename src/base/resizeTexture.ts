import gm from 'gm';
import { bufferHash } from './caching';

import type { PackedResizeOption } from './external-types';
import type { ProcessedTextureList } from './internal-types';
import type { Logger } from './Logger';

function resizeOptMatches(a: PackedResizeOption, b: PackedResizeOption) {
    return a === b || (a[0] === b[0] && a[1] === b[1] && (a[2] ?? '!') === (b[2] ?? '!'));
}

export function resizeTexture(textures: ProcessedTextureList, origHash: string, resizeOpt: PackedResizeOption, save: boolean, inBuf: Buffer, logger: Logger): Promise<[buffer: Buffer, hash: string, cached: boolean]> {
    return new Promise((resolve, reject) => {
        // normalize to 'keep'
        if (Array.isArray(resizeOpt) && resizeOpt[0] === 100 && resizeOpt[1] === 100 && resizeOpt[2] === '%') {
            resizeOpt = 'keep';
        }

        // check if this resize operation has already been done
        for (let i = 0; i < textures.length; i++) {
            const [oInputs, oHash, oBuffer, _save] = textures[i];

            for (const [oResizeOpt, oOrigHash] of oInputs) {
                if (origHash === oOrigHash && resizeOptMatches(oResizeOpt, resizeOpt)) {
                    if (save) {
                        textures[i][3] = true;
                    }

                    resolve([oBuffer, oHash, true]);
                    return;
                }
            }
        }

        if (resizeOpt === 'keep') {
            throw new Error('No match despite resizeOpt being "keep"');
        }

        // none of the inputs match, call graphicsmagick
        gm(inBuf).resize(...resizeOpt).toBuffer((err, outBuf) => {
            if (err === null) {
                const outHash = bufferHash(outBuf);

                // check if this resize operation has already been done, but
                // only the output matches
                for (let i = 0; i < textures.length; i++) {
                    const [oInputs, oHash, oBuffer, _save] = textures[i];

                    if (outHash === oHash) {
                        if (save) {
                            textures[i][3] = true;
                        }

                        logger.warn(`Resize option is equivalent to another resize option, but this is not obvious. Try to write resize options in a normalized way to minimise repeated work`);
                        oInputs.push([resizeOpt, origHash]);
                        resolve([oBuffer, oHash, false]);
                        return;
                    }
                }

                // none of the outputs match, add to processed textures list
                textures.push([[[resizeOpt, origHash]], outHash, outBuf, save]);
                resolve([outBuf, outHash, false]);
            } else {
                reject(err);
            }
        });
    });
}