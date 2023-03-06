import { basename } from 'node:path';
import splitModel from './lib';

import type { LODConfigList, PackedResizeOption } from '.';

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
    console.log(`
Usage:
${execName} <input file> <output folder> [--embed-textures] [--texture-size <percentage or target side length>] <lod 1 simplification ratio>[:<texture percentage or target side length>] <lod 2 simplification ratio>[:<texture percentage or target side length>] ...

Example usage:
- Split a model named "model.glb" into the folder "output" with 6 LOD levels (100%, 90%, 75%, 50%, 25%, and 12.5% mesh kept) and a texture size of 25%
${execName} model.glb output 1 0.9 0.75 0.5 0.25 0.125 --texture-size 25%
- Split a model named "model.glb" into the folder "output" with 4 LOD levels (100%, 75%, 50%, and 25% mesh kept) and a texture size of 100%, 50%, 25% and 12.5% respectively
${execName} model.glb output 1 0.75:50% 0.5:25% 0.25:12.5%

Options:
- <input file>: The model file to split into LODs
- <output folder>: The folder to put the split model into
- --embed-textures: Force each LOD model to have embedded textures instead of external textures
- --texture-size <percentage or target side length>: The texture size to use for each generated LOD if it's not specified in the LOD arguments
- <lod simplification ratio>[:<texture percentage or target side length>]: Adds an LOD to be generated. The simplification ratio determines how much to simplify the model; 1 is no simplification, 0.5 is 50% simplification. The texture option is equivalent to "--texture-size" but only applies to this LOD`
    );
}

// running from CLI. parse arguments
let inputPath = null;
let outputFolder = null;
let resizeOpts = null;
let embedTextures = false;
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
            resizeOpts = parseResizeArg(arg);
        } else if (arg === '--texture-size') {
            if (resizeOpts !== null) {
                throw new Error('--texture-size can only be specified once');
            }

            expectResizeOpt = true;
        } else if (arg === '--embed-textures') {
            embedTextures = true;
        } else {
            const parts = arg.split(':');
            if (parts.length > 2) {
                throw new Error('LOD arguments can have at most 2 parts');
            }

            let lodRatio = 1;
            if (parts[0] !== '') {
                lodRatio = Number(parts[0]);
                if (isNaN(lodRatio) || lodRatio <= 0 || lodRatio > 1) {
                    throw new Error('Invalid LOD simplification ratio. Must be a number > 0 and <= 1');
                }
            }

            let resizeOpt: PackedResizeOption | null = null;
            if (parts[1] !== '' && parts[1] !== undefined) {
                resizeOpt = parseResizeArg(parts[1]);
            }

            lods.push([lodRatio, resizeOpt]);
        }
    }

    if (expectResizeOpt) {
        throw new Error('Expected texture size');
    } else if (inputPath === null) {
        throw new Error('Input path not specified');
    } else if (outputFolder === null) {
        throw new Error('Output folder not specified');
    }
} catch (e) {
    console.error(e);
    printHelp(process.argv[1]);
    process.exit(1);
}

try {
    splitModel(inputPath, outputFolder, lods, embedTextures, resizeOpts);
} catch(e) {
    console.error('Error occurred while splitting model:', e);
    process.exit(2);
}