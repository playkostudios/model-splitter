import { basename } from 'node:path';
import { splitModel, CollisionError, InvalidInputError, LogLevel } from './lib';
import { version } from '../../package.json';
import { parseTextureSize } from './parseTextureSize';
import { ConsoleLogger } from './ConsoleLogger';

import type { LODConfigList, PackedResizeOption, DefaultablePackedResizeOption } from './lib';

function printHelp(execPath: string) {
    const execName = basename(execPath);
    console.log(`\
models-splitter ${version}

Usage:
${execName} <input file> <output folder> [--embed-textures] [--texture-size <percentage or target side length>] <lod 1 simplification ratio>[:<texture percentage or target side length>] <lod 2 simplification ratio>[:<texture percentage or target side length>] ...

Example usage:
- Split a model named "model.glb" into the folder "output" with 6 LOD levels (100%, 90%, 75%, 50%, 25%, and 12.5% mesh kept) and a texture size of 25%
${execName} model.glb output 1 0.9 0.75 0.5 0.25 0.125 --texture-size 25%
- Split a model named "model.glb" into the folder "output" with 4 LOD levels (100%, 75%, 50%, and 25% mesh kept) and a texture size of 100%, 50%, 25% and 12.5% respectively
${execName} model.glb output 1 0.75:50% 0.5:25% 0.25:12.5%
- Split a model named "model.glb" into the folder "output" with 4 LOD levels (100%, 75%, 50%, and 25% mesh kept), a texture size of 100%, 50%, 25% and 12.5% respectively, and keep the scene hierarchy, except for the lowest LOD
${execName} model.glb output 1 0.75:50% 0.5:25% 0.25:12.5%:optimize-scene-hierarchy --keep-scene-hierarchy

Options:
- <input file>: The model file to split into LODs
- <output folder>: The folder to put the split model into
- <lod simplification ratio>[:<texture percentage or target side length>][:optimize-scene-hierarchy][:keep-scene-hierarchy][:merge-materials][:no-material-merging][:aggressive][:not-aggressive]: Adds an LOD to be generated. The simplification ratio determines how much to simplify the model; 1 is no simplification, 0.5 is 50% simplification. The texture, scene hierarchy, and material options are equivalent to (or counteract), respectively, "--texture-size", "--keep-scene-hierarchy", "--no-material-merging" and "--aggressive" but only apply to this LOD
- --force: Replace existing files. This flag is not set by default, meaning that if a file needs to be replaced the tool will throw an error
- --embed-textures: Force each LOD model to have embedded textures instead of external textures
- --keep-scene-hierarchy: Don't optimize the scene hierarchy; keeps the same hierarchy instead of merging nodes, at the expense of higher draw calls. Can be overridden per LOD
- --no-material-merging: Don't merge materials and keep material names. Can be overridden per LOD
- --aggressive: Simplify mesh disregarding quality. Can be overridden per LOD
- --texture-size <percentage or target side length>: The texture size to use for each generated LOD if it's not specified in the LOD arguments
- --log-level <log level>: The log level to use. Can be: 'none', 'error', 'warning', 'log' or 'debug'
- --version: Print version and exit
- --help: Print help and exit`
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
    let textureSizeSpecified = false;
    let defaultAggressive = false;
    let logLevel = null;
    const lods: LODConfigList = [];

    try {
        const cliArgs = process.argv.slice(2);
        let expectResizeOpt = false;
        let expectLogLevel = false;

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

                if (arg === 'none') {
                    logLevel = LogLevel.None;
                } else if (arg === 'error') {
                    logLevel = LogLevel.Error;
                } else if (arg === 'warning') {
                    logLevel = LogLevel.Warning;
                } else if (arg === 'log') {
                    logLevel = LogLevel.Log;
                } else if (arg === 'debug') {
                    logLevel = LogLevel.Debug;
                } else {
                    throw new Error(`Invalid log level "${arg}"`);
                }
            } else if (arg === '--help') {
                printHelp(process.argv[1]);
                process.exit(0);
            } else if (arg === '--version') {
                console.log(version);
                process.exit(0);
            } else if (arg === '--texture-size') {
                if (textureSizeSpecified) {
                    throw new Error('--texture-size can only be specified once');
                }

                expectResizeOpt = true;
                textureSizeSpecified = true;
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

                if (logLevel !== null) {
                    throw new Error('Log level can only be specified once');
                }
            } else {
                const parts = arg.split(':');
                let meshLODRatio = 1;
                let embedTextures: boolean | null = null;
                let textureResizing: DefaultablePackedResizeOption = 'default';
                let optimizeSceneHierarchy: boolean | null = null;
                let mergeMaterials: boolean | null = null;
                let aggressive: boolean | null = null;
                let focus = 0;

                for (const partUntrimmed of parts) {
                    const part = partUntrimmed.trim();

                    if (part === 'embed-textures') {
                        if (embedTextures !== null) {
                            throw new Error('Texture embedding LOD option can only be specified once');
                        }

                        embedTextures = true;
                    } else if (part === 'external-textures') {
                        if (embedTextures !== null) {
                            throw new Error('Texture embedding LOD option can only be specified once');
                        }

                        embedTextures = false;
                    } else if (part === 'optimize-scene-hierarchy') {
                        if (optimizeSceneHierarchy !== null) {
                            throw new Error('Scene hierarchy LOD option can only be specified once');
                        }

                        optimizeSceneHierarchy = true;
                    } else if (part === 'keep-scene-hierarchy') {
                        if (optimizeSceneHierarchy !== null) {
                            throw new Error('Scene hierarchy LOD option can only be specified once');
                        }

                        optimizeSceneHierarchy = false;
                    } else if (part === 'merge-materials') {
                        if (mergeMaterials !== null) {
                            throw new Error('Material merging LOD option can only be specified once');
                        }

                        mergeMaterials = true;
                    } else if (part === 'no-material-merging') {
                        if (mergeMaterials !== null) {
                            throw new Error('Material merging LOD option can only be specified once');
                        }

                        mergeMaterials = false;
                    } else if (part === 'aggressive') {
                        if (aggressive !== null) {
                            throw new Error('Aggressivity LOD option can only be specified once');
                        }

                        aggressive = true;
                    } else if (part === 'not-aggressive') {
                        if (aggressive !== null) {
                            throw new Error('Aggressivity LOD option can only be specified once');
                        }

                        aggressive = false;
                    } else if (focus === 0) {
                        focus++;

                        if (part !== '') {
                            meshLODRatio = Number(part);
                            if (isNaN(meshLODRatio) || meshLODRatio <= 0 || meshLODRatio > 1) {
                                throw new Error('Invalid LOD simplification ratio. Must be a number > 0 and <= 1');
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
                    mergeMaterials, aggressive, embedTextures
                });
            }
        }

        if (expectResizeOpt) {
            throw new Error('Expected texture size');
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

    const logger = new ConsoleLogger(logLevel ?? LogLevel.Log);

    try {
        await splitModel(inputPath, outputFolder, lods, {
            defaultEmbedTextures, defaultTextureResizing, force,
            defaultOptimizeSceneHierarchy, defaultMergeMaterials,
            defaultAggressive, logger
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