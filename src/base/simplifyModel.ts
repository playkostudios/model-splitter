import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { InvalidInputError } from './ModelSplitterError';
import { resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { getDefaultGltfpackPath } from './getDefaultGltfpackPath';

import type { ILogger } from '@gltf-transform/core';
import type { GltfpackArgCombo } from './internal-types';
import type { BasisUniversalMode, PackedResizeOption } from './external-types';

let run = 0;

function gltfpackSpawn(workingDir: string, maybeGltfpackPath: string | null, gltfpackArgs: Array<string>, logger: ILogger): Promise<void> {
    let gltfpackPath: string;
    if (maybeGltfpackPath === null || maybeGltfpackPath === '') {
        gltfpackPath = getDefaultGltfpackPath();
    } else {
        gltfpackPath = maybeGltfpackPath;
    }

    logger.debug(`Spawning process: ${gltfpackPath} ${gltfpackArgs.join(' ')}`);

    return new Promise((resolve, reject) => {
        const childProc = spawn(gltfpackPath, gltfpackArgs, {
            cwd: workingDir,
            windowsHide: true
        });

        let done = false;
        childProc.on('exit', (code, signal) => {
            if (done) {
                return;
            }

            done = true;

            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`gltfpack exited with code ${code} and signal ${signal}.`));
            }
        });

        childProc.on('error', (err) => {
            if (done) {
                return;
            }

            done = true;
            reject(err);
        });

        childProc.stdout.on('data', (chunk: string | Buffer | null) => {
            if (typeof chunk === 'string') {
                logger.info(`[gltfpack] ${chunk}`);
            } else if (chunk !== null) {
                logger.info(`[gltfpack] ${chunk.toString()}`);
            }
        });

        childProc.stderr.on('data', (chunk: string | Buffer | null) => {
            let str: string;
            if (typeof chunk === 'string') {
                str = chunk;
            } else if (chunk !== null) {
                str = chunk.toString();
            } else {
                return;
            }

            if (str.startsWith('Warning')) {
                logger.warn(`[gltfpack] ${str}`);
            } else {
                logger.error(`[gltfpack] ${str}`);
            }
        });
    });
}

async function gltfpackPass(tempFolderPath: string, gltfpackPath: string | null, modelBuffer: Uint8Array, lodRatio: number, optimizeSceneHierarchy: boolean, mergeMaterials: boolean, aggressive: boolean, basisu: BasisUniversalMode, basisuResize: PackedResizeOption, logger: ILogger): Promise<Uint8Array> {
    // make temp folder
    logger.debug(`Making temporary sub-folder "${tempFolderPath}"...`);
    mkdirSync(tempFolderPath, { recursive: true });

    // build argument list
    const inputPath = resolvePath(tempFolderPath, 'input-model.glb');
    const outputPath = resolvePath(tempFolderPath, 'output-model.glb');
    const args = ['-i', inputPath, '-o', outputPath, '-noq'];

    if (!optimizeSceneHierarchy) {
        args.push('-kn');
    }

    if (!mergeMaterials) {
        args.push('-km');
    }

    if (basisu !== 'disabled') {
        args.push('-tc');

        if (basisu === 'uastc') {
            args.push('-tu');
        }

        if (basisuResize !== 'keep') {
            let commonDim = basisuResize[0];
            if (commonDim !== basisuResize[1]) {
                commonDim = Math.max(commonDim, basisuResize[1]);
                logger.warn("gltfpack doesn't support different sizes per dimension. Using biggest length for both dimensions");
            }

            if (basisuResize[2] === '%') {
                args.push('-ts', `${commonDim / 100}`);
            } else {
                logger.warn('Scaling to absolute sizes in gltfpack limits textures to a length; texture sizes never increase');
                args.push('-tl', `${commonDim}`);
            }
        }
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
    logger.debug(`Writing to temporary input model file "${inputPath}"`);
    writeFileSync(inputPath, modelBuffer);
    logger.debug(`Done writing`);

    await gltfpackSpawn(tempFolderPath, gltfpackPath, args, logger);

    logger.debug(`Reading from temporary output model file "${outputPath}"`);
    const output = readFileSync(outputPath);
    logger.debug(`Done reading`);

    // delete temp folder
    logger.debug(`Deleting temporary sub-folder "${tempFolderPath}"...`);
    rmSync(tempFolderPath, { recursive: true, force: true });
    return output;
}

export async function simplifyModel(tempFolderPath: string, gltfpackPath: string | null, modelBuffer: Uint8Array, gltfpackArgCombos: Array<GltfpackArgCombo>, gacIdx: number, logger: ILogger): Promise<Uint8Array> {
    return await gltfpackPass(resolvePath(tempFolderPath, `run-${run++}`), gltfpackPath, modelBuffer, ...gltfpackArgCombos[gacIdx], logger);
}