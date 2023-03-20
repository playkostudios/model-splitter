import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { basename, extname, resolve as resolvePath } from 'node:path';
import { ConsoleLogger } from './ConsoleLogger';
import { splitSingleLOD } from './splitSingleLOD';
import { InvalidInputError } from './ModelSplitterError';
import { assertFreeFile } from './assertFreeFile';
import { simplifyModel } from './simplifyModel';
import { bufferHash, getProcessedTexture, parseBuffer } from './caching';
import { deepClone } from './deepClone';

import type { IGLTF, IImage } from 'babylonjs-gltf2interface';
import type { Metadata } from './output-types';
import type { GltfpackArgCombo, OriginalImagesList, ParsedLODConfigList, ProcessedTextureList } from './internal-types';
import type { LODConfigList, PackedResizeOption, SplitModelOptions } from './external-types';

export * from './ModelSplitterError';
export * from './external-types';
export * from './LogLevel';

export async function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions = {}) {
    // parse options and get defaults
    const defaultEmbedTextures = options.defaultEmbedTextures ?? false;
    const defaultResizeOpt: PackedResizeOption = options.defaultTextureResizing ?? 'keep';
    const defaultOptimizeSceneHierarchy = options.defaultOptimizeSceneHierarchy ?? true;
    const defaultMergeMaterials = options.defaultMergeMaterials ?? true;
    const defaultAggressive = options.defaultAggressive ?? false;
    let force = options.force ?? false;
    const logger = options.logger ?? new ConsoleLogger();

    // verify that input model exists
    if (!existsSync(inputModelPath)) {
        throw new InvalidInputError(`Input path "${inputModelPath}" does not exist`);
    }

    if (!statSync(inputModelPath).isFile()) {
        throw new InvalidInputError(`Input path "${inputModelPath}" is not a file`);
    }

    // make final LOD configs with defaults applied, and verify validity
    const gltfpackArgCombos = new Array<GltfpackArgCombo>();
    const lodsParsed: ParsedLODConfigList = [];
    const lodCount = lods.length;
    for (let i = 0; i < lodCount; i++) {
        const lod = lods[i];

        // parse resize option
        let resolvedResizeOpt: PackedResizeOption;
        const rawResizeOpt = lod?.textureResizing ?? 'default';
        if (rawResizeOpt === 'default') {
            resolvedResizeOpt = defaultResizeOpt;
        } else if (Array.isArray(rawResizeOpt)) {
            const concreteResOpts = rawResizeOpt;
            if (concreteResOpts[2] === '%' && concreteResOpts[0] === 100 && concreteResOpts[1] === 100) {
                resolvedResizeOpt = 'keep';
            } else {
                resolvedResizeOpt = concreteResOpts;
            }
        } else {
            resolvedResizeOpt = rawResizeOpt;
        }

        // parse gltfpack options
        const lodRatio = lod.meshLODRatio;
        const optimizeSceneHierarchy = lod.optimizeSceneHierarchy ?? defaultOptimizeSceneHierarchy;
        const mergeMaterials = lod.mergeMaterials ?? defaultMergeMaterials;
        const aggressive = lod.aggressive ?? defaultAggressive;

        let gacIdx = 0;
        const gacCount = gltfpackArgCombos.length;
        for (; gacIdx < gacCount; gacIdx++) {
            const gac = gltfpackArgCombos[gacIdx];
            if (gac[0] === lodRatio && gac[1] === optimizeSceneHierarchy && gac[2] === mergeMaterials && gac[3] === aggressive) {
                break;
            }
        }

        if (gacIdx === gacCount) {
            gltfpackArgCombos.push([lodRatio, optimizeSceneHierarchy, mergeMaterials, aggressive]);
        }

        // parse other options
        const embedTextures = lod.embedTextures ?? defaultEmbedTextures;

        // done
        lodsParsed.push([gacIdx, resolvedResizeOpt, embedTextures]);
    }

    if (lodsParsed.length === 0) {
        throw new InvalidInputError('Nothing to do');
    }

    // make output folder if needed, or verify that it's a folder
    if (existsSync(outputFolder)) {
        // verify that the output path really is a folder
        if (!statSync(outputFolder).isDirectory()) {
            throw new InvalidInputError(`Output path "${outputFolder}" is not a directory`);
        }
    } else {
        mkdirSync(outputFolder, { recursive: true }) as string;
        // XXX folder doesn't exist, no need to prevent file replacing
        force = true;
    }

    // extract model name
    let modelName = basename(inputModelPath);
    const extLen = extname(modelName).length;
    if (extLen > 0) {
        modelName = modelName.substring(0, modelName.length - extLen);
    }

    // make sure output files are free (double/triple-checked later)
    if (!force) {
        for (let l = 0; l < lodCount; l++) {
            assertFreeFile(resolvePath(outputFolder, `${modelName}.LOD${l}.glb`));
        }
    }

    // run gltfpack
    const gacCount = gltfpackArgCombos.length;
    const origInputModel = readFileSync(inputModelPath);
    const gltfpackOutputs = new Array<IGLTF>(gacCount);
    const gltfpackPromises = new Array<Promise<void>>();

    for (let i = 0; i < gacCount; i++) {
        const gacIdx = i;
        gltfpackPromises.push(simplifyModel(origInputModel, gltfpackArgCombos, gltfpackOutputs, gacIdx, logger));
    }

    await Promise.all(gltfpackPromises);

    // verify gltfpack outputs the same amount of images, that the images use
    // bufferViews, and parse the buffers where the images are
    const gltfFirst = gltfpackOutputs[0];
    const expectedImageCount = gltfFirst?.images?.length ?? 0;
    const parsedBuffers = new Array<Buffer>();
    for (let i = 0; i < gacCount; i++) {
        const thisOutput = gltfpackOutputs[i];
        const thisImages = thisOutput?.images;
        const thisImageCount = thisImages?.length ?? 0;
        if (thisImageCount !== expectedImageCount) {
            throw new Error(`Unexpected image count in gltfpack output; expected ${expectedImageCount}, got ${thisImageCount}`);
        }

        if (thisImageCount > 0) {
            for (const image of thisImages as Array<IImage>) {
                const bufferViewIdx = image.bufferView;
                if (bufferViewIdx === undefined) {
                    throw new Error('Unexpected image without bufferView in gltfpack output');
                }

                const bufferViews = thisOutput.bufferViews;
                if (bufferViews === undefined) {
                    throw new Error('Unexpected missing bufferViews array in gltfpack output');
                }

                const bufferView = bufferViews[bufferViewIdx];
                if (bufferView === undefined) {
                    throw new Error('Unexpected missing bufferView in gltfpack output');
                }

                const buffers = thisOutput.buffers;
                if (buffers === undefined) {
                    throw new Error('Unexpected missing buffers array in gltfpack output');
                }

                parseBuffer(parsedBuffers, buffers[bufferView.buffer]);
            }
        }
    }

    // extract original images
    const textures: ProcessedTextureList = [];
    const originalImages: OriginalImagesList = [];
    if (expectedImageCount > 0) {
        const images = gltfFirst.images as Array<IImage>;
        for (const image of images) {
            if (image.bufferView === undefined) {
                continue;
            }

            if (gltfFirst.bufferViews === undefined) {
                throw new Error('Unexpected missing bufferViews array');
            }

            const bufferView = gltfFirst.bufferViews[image.bufferView];
            const bufferIdx = bufferView.buffer;
            const bufferLen = bufferView.byteLength;
            const bufferOffset = bufferView.byteOffset ?? 0;

            if (gltfFirst.buffers === undefined) {
                throw new Error('Unexpected missing buffers array');
            }

            const buffer = parseBuffer(parsedBuffers, gltfFirst.buffers[bufferIdx]);
            let imageBuffer = buffer.subarray(bufferOffset, bufferOffset + bufferLen);

            const hash = bufferHash(imageBuffer);
            imageBuffer = getProcessedTexture(textures, hash, hash, imageBuffer, 'keep');

            originalImages.push([imageBuffer, hash]);
        }
    }

    // clone packed GLTFs when necessary
    const gltfs = new Array<IGLTF>(lodCount);
    const gltfpackVisited = new Set<number>();

    for (let i = 0; i < lodCount; i++) {
        const lod = lodsParsed[i];
        const gacIdx = lod[0];

        if (gltfpackVisited.has(gacIdx)) {
            gltfs[i] = deepClone(gltfpackOutputs[gacIdx]);
        } else {
            gltfpackVisited.add(gacIdx);
            gltfs[i] = gltfpackOutputs[gacIdx];
        }
    }

    // generate each lod
    // WARNING this assumes that every output packed gltf has the same images at
    //         the same indices
    const metadata: Metadata = {
        lods: []
    };

    for (let l = 0; l < lodCount; l++) {
        logger.debug(`Starting to generate LOD${l}...`);
        const outName = `${modelName}.LOD${l}.glb`;
        const outPath = resolvePath(outputFolder, outName);
        await splitSingleLOD(outName, outPath, metadata, gltfpackArgCombos, gltfs[l], lodsParsed[l], originalImages, textures, parsedBuffers, expectedImageCount, force, logger);
    }

    // write non-embedded textures to final destination
    for (const [_inputs, hash, content, save] of textures) {
        if (!save) {
            continue;
        }

        const outPath = resolvePath(outputFolder, hash);
        logger.debug(`Writing external texture ${outPath}...`);

        if (!force) {
            assertFreeFile(outPath);
        }

        writeFileSync(outPath, content);
        logger.debug(`Done`);
    }

    // write metadata to final destination
    const outPath = resolvePath(outputFolder, `${modelName}.metadata.json`);
    logger.debug(`Writing metadata file ${outPath}...`);

    if (!force) {
        assertFreeFile(outPath);
    }

    writeFileSync(outPath, JSON.stringify(metadata));
    logger.debug(`All done`);
}
