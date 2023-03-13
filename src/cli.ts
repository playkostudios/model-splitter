import { basename } from 'node:path';
import splitModel, { CollisionError, InvalidInputError } from './lib';
import { version } from '../package.json';

import type { LODConfigList, PackedResizeOption, DefaultablePackedResizeOption } from './lib';

function parseResizeArg(arg: string): PackedResizeOption {
    if (arg.endsWith('%')) {
        const percent = Number(arg.substring(0, arg.length - 1));
        if (isNaN(percent) || percent <= 0) {
            throw new Error('Invalid percentage. Must be a number > 0');
        }

        return [percent, percent, '%'];
    } else {
        const sideLength = Number(arg);
        if (isNaN(sideLength) || sideLength <= 0) {
            throw new Error('Invalid side length. Must be a number > 0');
        }

        return [sideLength, sideLength, '!'];
    }
}

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
- <lod simplification ratio>[:<texture percentage or target side length>][:optimize-scene-hierarchy][:keep-scene-hierarchy][:merge-materials][:no-material-merging]: Adds an LOD to be generated. The simplification ratio determines how much to simplify the model; 1 is no simplification, 0.5 is 50% simplification. The texture, scene hierarchy, and material options are equivalent to (or counteract), respectively, "--texture-size", "--keep-scene-hierarchy" and "no-material-merging" but only apply to this LOD
- --force: Replace existing files. This flag is not set by default, meaning that if a file needs to be replaced the tool will throw an error
- --embed-textures: Force each LOD model to have embedded textures instead of external textures
- --keep-scene-hierarchy: Don't optimize the scene hierarchy; keeps the same hierarchy instead of merging nodes, at the expense of higher draw calls. Can be overridden per LOD
- --no-material-merging: Don't merge materials and keep material names. Can be overridden per LOD
- --texture-size <percentage or target side length>: The texture size to use for each generated LOD if it's not specified in the LOD arguments
- --version: Print version and exit
- --help: Print help and exit`
    );
}

async function main() {
    // running from CLI. parse arguments
    let inputPath: string | null = null;
    let outputFolder: string | null = null;
    let defaultResizeOpt: PackedResizeOption = 'keep';
    let force = false;
    let embedTextures = false;
    let defaultKeepSceneHierarchy = false;
    let defaultNoMaterialMerging = false;
    let textureSizeSpecified = false;
    const lods: LODConfigList = [];

    try {
        const cliArgs = process.argv.slice(2);
        let expectResizeOpt = false;

        for (const arg of cliArgs) {
            if (inputPath === null) {
                inputPath = arg;
            } else if (outputFolder === null) {
                outputFolder = arg;
            } else if (expectResizeOpt) {
                expectResizeOpt = false;
                defaultResizeOpt = parseResizeArg(arg);
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
                force = false;
            } else if (arg === '--embed-textures') {
                embedTextures = true;
            } else if (arg === '--keep-scene-hierarchy') {
                defaultKeepSceneHierarchy = true;
            } else if (arg === '--no-material-merging') {
                defaultNoMaterialMerging = true;
            } else {
                const parts = arg.split(':');
                if (parts.length > 2) {
                    throw new Error('LOD arguments can have at most 2 parts');
                }

                let lodRatio = 1;
                let resizeOpt: DefaultablePackedResizeOption = 'default';
                let keepSceneHierarchy: boolean | null = null;
                let noMaterialMerging: boolean | null = null;
                let focus = 0;

                for (const partUntrimmed of parts) {
                    const part = partUntrimmed.trim();

                    if (part === 'optimize-scene-hierarchy') {
                        if (keepSceneHierarchy !== null) {
                            throw new Error('Scene hierarchy LOD option can only be specified once');
                        }

                        keepSceneHierarchy = false;
                    } else if (part === 'keep-scene-hierarchy') {
                        if (keepSceneHierarchy !== null) {
                            throw new Error('Scene hierarchy LOD option can only be specified once');
                        }

                        keepSceneHierarchy = true;
                    } else if (part === 'merge-materials') {
                        if (noMaterialMerging !== null) {
                            throw new Error('Material merging LOD option can only be specified once');
                        }

                        noMaterialMerging = false;
                    } else if (part === 'no-material-merging') {
                        if (noMaterialMerging !== null) {
                            throw new Error('Material merging LOD option can only be specified once');
                        }

                        noMaterialMerging = true;
                    } else if (focus === 0) {
                        focus++;

                        if (part !== '') {
                            lodRatio = Number(part);
                            if (isNaN(lodRatio) || lodRatio <= 0 || lodRatio > 1) {
                                throw new Error('Invalid LOD simplification ratio. Must be a number > 0 and <= 1');
                            }
                        }
                    } else if (focus === 1) {
                        focus++;

                        if (part !== '') {
                            resizeOpt = parseResizeArg(part);
                        }
                    } else {
                        throw new Error('Too many unnamed LOD options');
                    }
                }


                lods.push([lodRatio, resizeOpt, keepSceneHierarchy, noMaterialMerging]);
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
        console.error(err.message);
        printHelp(process.argv[1]);
        process.exit(1);
    }

    try {
        await splitModel(inputPath, outputFolder, lods, {
            embedTextures, defaultResizeOpt, force, defaultKeepSceneHierarchy,
            defaultNoMaterialMerging,
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