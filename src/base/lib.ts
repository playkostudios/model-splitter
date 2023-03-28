import { writeFileSync, mkdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, extname, join as joinPath, resolve as resolvePath } from 'node:path';
import { splitSingleLOD } from './splitSingleLOD';
import { InvalidInputError } from './ModelSplitterError';
import { assertFreeFile } from './assertFreeFile';
import { simplifyModel } from './simplifyModel';
import { bufferHash, getProcessedTexture, parseBuffer } from './caching';
import { deepClone } from './deepClone';
import { ConsoleLogger } from './ConsoleLogger';

import type { IGLTF, IImage } from 'babylonjs-gltf2interface';
import type { Metadata } from './output-types';
import type { GltfpackArgCombo, OriginalImagesList, ParsedLODConfigList, ProcessedTextureList } from './internal-types';
import type { LODConfigList, PackedResizeOption, SplitModelOptions } from './external-types';
import { wlefyModel } from './wlefyModel';
import { tmpdir } from 'node:os';

export * from './ModelSplitterError';
export * from './external-types';

async function _splitModel(tempFolderPath: string, inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions = {}) {
    // parse options and get defaults
    const defaultEmbedTextures = options.defaultEmbedTextures ?? false;
    const defaultResizeOpt: PackedResizeOption = options.defaultTextureResizing ?? 'keep';
    const defaultOptimizeSceneHierarchy = options.defaultOptimizeSceneHierarchy ?? true;
    const defaultMergeMaterials = options.defaultMergeMaterials ?? true;
    const defaultAggressive = options.defaultAggressive ?? false;
    const defaultBasisUniversal = options.defaultBasisUniversal ?? 'disabled';
    const gltfpackPath = options.gltfpackPath ?? null;
    let force = options.force ?? false;
    const logger = options.logger ?? new ConsoleLogger();

    // verify that input model exists
    if (!existsSync(inputModelPath)) {
        throw InvalidInputError.fromDesc(`Input path "${inputModelPath}" does not exist`);
    }

    if (!statSync(inputModelPath).isFile()) {
        throw InvalidInputError.fromDesc(`Input path "${inputModelPath}" is not a file`);
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
        const basisUniversal = lod.basisUniversal ?? defaultBasisUniversal;

        let gacIdx = 0;
        const gacCount = gltfpackArgCombos.length;
        for (; gacIdx < gacCount; gacIdx++) {
            const gac = gltfpackArgCombos[gacIdx];
            if (gac[0] === lodRatio && gac[1] === optimizeSceneHierarchy && gac[2] === mergeMaterials && gac[3] === aggressive && gac[4] === basisUniversal && (basisUniversal === 'disabled' || gac[5] === resolvedResizeOpt)) {
                break;
            }
        }

        const basisu = basisUniversal !== 'disabled';
        if (gacIdx === gacCount) {
            gltfpackArgCombos.push([lodRatio, optimizeSceneHierarchy, mergeMaterials, aggressive, basisUniversal, basisu ? resolvedResizeOpt : 'keep']);
        }

        // parse other options
        let embedTextures = lod.embedTextures ?? defaultEmbedTextures;

        if (basisUniversal !== 'disabled' && embedTextures) {
            logger.warn("Basis Universal enabled for model, texture embedding force-disabled; Wonderland Engine doesn't support loading KTX2 textures, so they must be stored externally to be transcoded at runtime");
            embedTextures = false;
        }

        // done
        lodsParsed.push([gacIdx, basisu ? 'keep' : resolvedResizeOpt, embedTextures]);
    }

    if (lodsParsed.length === 0) {
        throw InvalidInputError.fromDesc('Nothing to do');
    }

    // make output folder if needed, or verify that it's a folder
    if (existsSync(outputFolder)) {
        // verify that the output path really is a folder
        if (!statSync(outputFolder).isDirectory()) {
            throw InvalidInputError.fromDesc(`Output path "${outputFolder}" is not a directory`);
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

    // convert model to a format usable by wonderland engine
    logger.debug('Converting to format usable by Wonderland Engine with glTF-Transform...');
    const wlefiedModel = await wlefyModel(inputModelPath, logger);

    // run gltfpack
    logger.debug('Compressing models with gltfpack...');
    const gacCount = gltfpackArgCombos.length;
    const gltfpackOutputs = new Array<IGLTF>(gacCount);
    const gltfpackPromises = new Array<Promise<void>>();

    for (let i = 0; i < gacCount; i++) {
        const gacIdx = i;
        gltfpackPromises.push(simplifyModel(tempFolderPath, gltfpackPath, wlefiedModel, gltfpackArgCombos, gltfpackOutputs, gacIdx, logger));
    }

    await Promise.all(gltfpackPromises);

    // verify gltfpack outputs the same amount of images, that the images use
    // bufferViews, and parse the buffers where the images are
    logger.debug('Verifying gltfpack image counts...');
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
    let gltfFirstNonBasisU = null;

    for (let i = 0; i < gacCount; i++) {
        if (gltfpackArgCombos[i][4] !== 'disabled') {
            continue;
        }

        gltfFirstNonBasisU = gltfpackOutputs[i];
    }

    if (gltfFirstNonBasisU !== null) {
        logger.debug('Reading original images...');
        if (expectedImageCount > 0) {
            const images = gltfFirstNonBasisU.images as Array<IImage>;
            for (const image of images) {
                if (image.bufferView === undefined || image.mimeType as string === 'image/ktx2') {
                    originalImages.push(null);
                    continue;
                }

                if (gltfFirstNonBasisU.bufferViews === undefined) {
                    throw new Error('Unexpected missing bufferViews array');
                }

                const bufferView = gltfFirstNonBasisU.bufferViews[image.bufferView];
                const bufferIdx = bufferView.buffer;
                const bufferLen = bufferView.byteLength;
                const bufferOffset = bufferView.byteOffset ?? 0;

                if (gltfFirstNonBasisU.buffers === undefined) {
                    throw new Error('Unexpected missing buffers array');
                }

                const buffer = parseBuffer(parsedBuffers, gltfFirstNonBasisU.buffers[bufferIdx]);
                let imageBuffer = buffer.subarray(bufferOffset, bufferOffset + bufferLen);

                const hash = bufferHash(imageBuffer);
                imageBuffer = getProcessedTexture(textures, hash, hash, imageBuffer, 'keep');

                originalImages.push([imageBuffer, hash]);
            }
        }
    } else {
        for (let i = 0; i < expectedImageCount; i++) {
            originalImages.push(null);
        }
    }

    // clone packed GLTFs when necessary
    logger.debug('Cloning GLTFs...');
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

export async function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options?: SplitModelOptions) {
    // make temp folder
    const tempFolderPath = mkdtempSync(joinPath(tmpdir(), 'model-splitter-'));

    if (!statSync(tempFolderPath).isDirectory()) {
        throw new Error('Failed to create temporary directory; not a directory');
    }

    try {
        return await _splitModel(tempFolderPath, inputModelPath, outputFolder, lods, options);
    } finally {
        rmSync(tempFolderPath, { recursive: true, force: true });
    }
}