import { basename } from 'node:path';
import { splitModel, CollisionError, InvalidInputError } from './lib';
import { version } from '../../package.json';
import { parseTextureSize } from './parseTextureSize';
import { Verbosity } from '@gltf-transform/core';
import { ConsoleLogger } from './ConsoleLogger';
import { getDefaultGltfpackPath } from './getDefaultGltfpackPath';
import { getUsageString } from './getUsageString';

import type { LODConfigList, PackedResizeOption, DefaultablePackedResizeOption, BasisUniversalMode } from './lib';

function printHelp(execPath: string) {
    console.log(`\
models-splitter ${version}

${getUsageString(basename(execPath), '"' + getDefaultGltfpackPath() + '"')}`
    );
}

async function main() {
    // running from CLI. parse arguments
    let inputPath: string | null = null;
    let outputFolder: string | null = null;
    let defaultTextureResizing: PackedResizeOption = 'keep';
    let force = false;
    let defaultEmbedTextures = false;
    let defaultOptimizeSceneHierarchy = true;
    let defaultMergeMaterials = true;
    let defaultAggressive = false;
    let defaultBasisUniversal: BasisUniversalMode = 'disabled';
    let gltfpackPath: string | undefined;
    let logLevel: Verbosity | null = null;
    const lods: LODConfigList = [];
    let splitDepth = 0;

    try {
        const cliArgs = process.argv.slice(2);
        let expectResizeOpt = false;
        let expectLogLevel = false;
        let expectBasisu = false;
        let expectGltfpackPath = false;
        let expectSplitDepth = false;

        for (const arg of cliArgs) {
            if (inputPath === null) {
                inputPath = arg;
            } else if (outputFolder === null) {
                outputFolder = arg;
            } else if (expectResizeOpt) {
                expectResizeOpt = false;
                defaultTextureResizing = parseTextureSize(arg, false);
            } else if (expectLogLevel) {
                expectLogLevel = false;

                if (arg === 'none' || arg === 'silent') {
                    logLevel = Verbosity.SILENT;
                } else if (arg === 'error' || arg === 'err') {
                    logLevel = Verbosity.ERROR;
                } else if (arg === 'warning' || arg === 'warn') {
                    logLevel = Verbosity.WARN;
                } else if (arg === 'info' || arg === 'log') {
                    logLevel = Verbosity.INFO;
                } else if (arg === 'debug' || arg === 'verbose') {
                    logLevel = Verbosity.DEBUG;
                } else {
                    throw new Error(`Invalid log level "${arg}"`);
                }
            } else if (expectBasisu) {
                expectBasisu = false;

                if (arg === 'disabled' || arg === 'uastc' || arg === 'etc1s') {
                    defaultBasisUniversal = arg;
                } else {
                    throw new Error(`Invalid basisu "${arg}"`);
                }
            } else if (expectGltfpackPath) {
                expectGltfpackPath = false;
                gltfpackPath = arg;
            } else if (expectSplitDepth) {
                expectSplitDepth = false;
                splitDepth = Number(arg);

                if (!Number.isInteger(splitDepth) || splitDepth < 0) {
                    throw new Error('Split depth must be a valid integer greater or equal to 0');
                }
            } else if (arg === '--help') {
                printHelp(process.argv[1]);
                process.exit(0);
            } else if (arg === '--version') {
                console.log(version);
                process.exit(0);
            } else if (arg === '--texture-size') {
                expectResizeOpt = true;
            } else if (arg === '--force') {
                force = true;
            } else if (arg === '--embed-textures') {
                defaultEmbedTextures = true;
            } else if (arg === '--keep-scene-hierarchy') {
                defaultOptimizeSceneHierarchy = false;
            } else if (arg === '--no-material-merging') {
                defaultMergeMaterials = false;
            } else if (arg === '--aggressive') {
                defaultAggressive = true;
            } else if (arg === '--log-level') {
                expectLogLevel = true;
            } else if (arg === '--basisu') {
                expectBasisu = true;
            } else if (arg === '--gltfpack-path') {
                expectGltfpackPath = true;
            } else if (arg === '--split-depth') {
                expectSplitDepth = true;
            } else {
                if (arg.startsWith('--')) {
                    throw new Error(`Unknown option: ${arg}`);
                }

                const parts = arg.split(':');
                let meshLODRatio = 1;
                let embedTextures: boolean | null = null;
                let textureResizing: DefaultablePackedResizeOption = 'default';
                let optimizeSceneHierarchy: boolean | null = null;
                let mergeMaterials: boolean | null = null;
                let aggressive: boolean | null = null;
                let basisUniversal: BasisUniversalMode | null = null;
                let focus = 0;

                for (const partUntrimmed of parts) {
                    const part = partUntrimmed.trim();

                    if (part === 'embed-textures') {
                        embedTextures = true;
                    } else if (part === 'external-textures') {
                        embedTextures = false;
                    } else if (part === 'optimize-scene-hierarchy') {
                        optimizeSceneHierarchy = true;
                    } else if (part === 'keep-scene-hierarchy') {
                        optimizeSceneHierarchy = false;
                    } else if (part === 'merge-materials') {
                        mergeMaterials = true;
                    } else if (part === 'no-material-merging') {
                        mergeMaterials = false;
                    } else if (part === 'aggressive') {
                        aggressive = true;
                    } else if (part === 'not-aggressive') {
                        aggressive = false;
                    } else if (part === 'no-basisu') {
                        basisUniversal = 'disabled';
                    } else if (part === 'uastc' || part === 'etc1s') {
                        basisUniversal = part;
                    } else if (focus === 0) {
                        focus++;

                        if (part !== '') {
                            meshLODRatio = Number(part);
                            if (isNaN(meshLODRatio) || meshLODRatio <= 0 || meshLODRatio > 1) {
                                throw new Error(`Invalid LOD simplification ratio "${part}". Must be a number > 0 and <= 1`);
                            }
                        }
                    } else if (focus === 1) {
                        focus++;

                        if (part !== '') {
                            textureResizing = parseTextureSize(part, true);
                        }
                    } else {
                        throw new Error('Too many unnamed LOD options');
                    }
                }


                lods.push({
                    meshLODRatio, textureResizing, optimizeSceneHierarchy,
                    mergeMaterials, aggressive, embedTextures, basisUniversal
                });
            }
        }

        if (expectResizeOpt) {
            throw new Error('Expected texture size');
        } else if (expectLogLevel) {
            throw new Error('Expected log level');
        } else if (expectBasisu) {
            throw new Error('Expected basisu mode');
        } else if (inputPath === null) {
            throw new Error('Input path not specified');
        } else if (outputFolder === null) {
            throw new Error('Output folder not specified');
        }
    } catch (err) {
        if (err !== null && typeof err === 'object') {
            console.error((err as Record<string, unknown>).message ?? err);
        } else {
            console.error(err);
        }

        printHelp(process.argv[1]);
        process.exit(1);
    }

    const logger = new ConsoleLogger(logLevel ?? Verbosity.INFO);

    try {
        await splitModel(inputPath, outputFolder, lods, {
            defaultEmbedTextures, defaultTextureResizing, force,
            defaultOptimizeSceneHierarchy, defaultMergeMaterials,
            defaultAggressive, defaultBasisUniversal, gltfpackPath, logger,
            splitDepth
        });
    } catch(err) {
        if (err instanceof CollisionError) {
            console.error(`Error occurred while splitting model: ${err.message}\nIf you wish to replace this file, run the tool with the "--force" option`);
            process.exit(4);
        } else if (err instanceof InvalidInputError) {
            console.error(`Error occurred while splitting model: ${err.message}`);
            printHelp(process.argv[1]);
            process.exit(1);
        } else {
            console.error('Error occurred while splitting model:', err);
            process.exit(2);
        }
    }
}

main();