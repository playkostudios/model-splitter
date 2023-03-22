const gltfpack = require('gltfpack');
const { glbToGltf } = require('gltf-pipeline');

import { readFileSync } from 'node:fs';
import { InvalidInputError } from './ModelSplitterError';

import type { ILogger } from '@gltf-transform/core';
import type { GltfpackArgCombo } from './internal-types';
import type { IGLTF } from 'babylonjs-gltf2interface';

async function gltfpackPass(modelBuffer: Uint8Array, isGLTF: boolean, lodRatio: number, optimizeSceneHierarchy: boolean, mergeMaterials: boolean, aggressive: boolean, logger: ILogger): Promise<Uint8Array> {
    // build argument list
    const inputPath = `argument://input-model.gl${isGLTF ? 'tf' : 'b'}`;
    const outputPath = 'argument://output-model.glb';
    const args = ['-i', inputPath, '-o', outputPath, '-noq'];

    if (!optimizeSceneHierarchy) {
        args.push('-kn');
    }

    if (!mergeMaterials) {
        args.push('-km');
    }

    if (lodRatio < 1) {
        if (lodRatio <= 0) {
            throw InvalidInputError.fromDesc('LOD levels must be greater than 0');
        }

        args.push('-si', `${lodRatio}`);

        if (aggressive) {
            args.push('-sa');
        }
    } else if (lodRatio > 1) {
        logger.warn('Ignored LOD ratio greater than 1; treating as 1 (no simplification)');
    }

    // simplify
    let output: Uint8Array | null = null;
    const log: string = await gltfpack.pack(args, {
        read: (filePath: string) => {
            if (filePath === inputPath) {
                return modelBuffer;
            } else {
                return readFileSync(filePath);
            }
        },
        write: (filePath: string, data: Uint8Array) => {
            if (filePath === outputPath) {
                output = data;
            } else {
                logger.warn(`Ignored unexpected gltfpack file write to path "${filePath}"`);
            }
        },
    });

    // extract output
    if (log !== '') {
        const lines = log.split('\n');

        for (const line of lines) {
            if (line === '') {
                continue;
            }

            const prefixLine = `[gltfpack] ${line}`;
            if (line.startsWith('Error')) {
                logger.error(prefixLine);
            } else if (line.startsWith('Warning')) {
                logger.warn(prefixLine);
            } else {
                logger.info(prefixLine);
            }
        }
    }

    if (output === null) {
        throw new Error('gltfpack had no output');
    }

    return output;
}

export function simplifyModel(modelBuffer: Uint8Array, gltfpackArgCombos: Array<GltfpackArgCombo>, gltfpackOutputs: Array<IGLTF>, gacIdx: number, logger: ILogger) {
    return new Promise<void>((resolve, reject) => {
        gltfpackPass(modelBuffer, false, ...gltfpackArgCombos[gacIdx], logger).then(buf => {
            return glbToGltf(buf);
        }).then(results => {
            if (results.separateResources && Object.getOwnPropertyNames(results.separateResources).length > 0) {
                throw new Error('Unexpected external resources in GLTF');
            }

            if (!results.gltf) {
                throw new Error('Unexpected missing GLTF in gltf-pipeline output');
            }

            gltfpackOutputs[gacIdx] = results.gltf;
            resolve();
        }).catch(reject);
    });
}