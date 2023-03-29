import { writeFileSync, mkdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, extname, join as joinPath, resolve as resolvePath } from 'node:path';
import { splitSingleLOD } from './splitSingleLOD';
import { InvalidInputError } from './ModelSplitterError';
import { assertFreeFile } from './assertFreeFile';
import { simplifyModel } from './simplifyModel';
import { ConsoleLogger } from './ConsoleLogger';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { PrefixedLogger } from './PrefixedLogger';
import { wlefyModel } from './wlefyModel';
import { tmpdir } from 'node:os';
import { PatchedNodeIO } from './PatchedNodeIO';

import type { Metadata } from './output-types';
import type { GltfpackArgCombo, ParsedLODConfigList } from './internal-types';
import type { LODConfigList, PackedResizeOption, SplitModelOptions } from './external-types';
import { PlaykoExternalWLEMaterial } from './PlaykoExternalWLEMaterial';

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

    // make node IO for gltf-transform
    const io = new PatchedNodeIO();
    io.setLogger(new PrefixedLogger('[glTF-Transform] ', logger));
    io.registerExtensions([ ...KHRONOS_EXTENSIONS, PlaykoExternalWLEMaterial ]);
    io.registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
    });

    // convert model to a format usable by wonderland engine
    logger.debug('Converting to format usable by Wonderland Engine...');
    const wlefiedModel = await wlefyModel(io, inputModelPath);

    // run gltfpack and generate each lod
    // WARNING this assumes that every output packed gltf has the same images at
    //         the same indices
    const gacCount = gltfpackArgCombos.length;
    const metadata: Metadata = {
        lods: []
    };

    for (let i = 0; i < gacCount; i++) {
        // run gltfpack
        const gacIdx = i;
        logger.debug(`Running gltfpack on argument combo ${i}...`);
        const glbBuf = await simplifyModel(tempFolderPath, gltfpackPath, wlefiedModel, gltfpackArgCombos, gacIdx, logger);

        // get lods that depend on this gltfpack argument combo (gac)
        for (let l = 0; l < lodCount; l++) {
            const lod = lodsParsed[l];
            if (gacIdx !== lod[0]) {
                continue;
            }

            logger.debug(`Starting to generate LOD${l}...`);
            const outName = `${modelName}.LOD${l}.glb`;
            await splitSingleLOD(logger, io, outName, outputFolder, metadata, gltfpackArgCombos, glbBuf, lod, force);
        }
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