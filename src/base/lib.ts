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
import { wlefyAndSplitModel } from './wlefyAndSplitModel';
import { tmpdir } from 'node:os';
import { PatchedNodeIO } from './PatchedNodeIO';
import { PlaykoExternalWLEMaterial } from './PlaykoExternalWLEMaterial';
import { TextureResizer } from './TextureResizer';

import type { Metadata } from './output-types';
import type { GltfpackArgCombo, ParsedLODConfigList } from './internal-types';
import type { LODConfigList, PackedResizeOption, SplitModelOptions } from './external-types';

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
    const splitDepth = options.splitDepth ?? 0;

    // verify that there is work to do
    const lodCount = lods.length;
    if (lodCount === 0) {
        throw InvalidInputError.fromDesc('Nothing to do, no LODS specified');
    }

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
    let hasTempCacheDep = false;
    let hasEmbedded = false;
    let nonBasisuCount = 0;
    let warnedEmbeddedBasisu = false;

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
            if (gac[0] === lodRatio && gac[1] === optimizeSceneHierarchy && gac[2] === mergeMaterials && gac[3] === aggressive && gac[4] === basisUniversal) {
                const oResolvedResizeOpt = gac[5];
                if (basisUniversal === 'disabled' || oResolvedResizeOpt === resolvedResizeOpt) {
                    break;
                } else if (Array.isArray(oResolvedResizeOpt) && Array.isArray(resolvedResizeOpt)) {
                    if (resolvedResizeOpt[0] === oResolvedResizeOpt[0] && resolvedResizeOpt[1] === oResolvedResizeOpt[1] && (resolvedResizeOpt[2] ?? '!') === (oResolvedResizeOpt[2] ?? '!')) {
                        break;
                    }
                }
            }
        }

        const basisu = basisUniversal !== 'disabled';
        if (gacIdx === gacCount) {
            gltfpackArgCombos.push([lodRatio, optimizeSceneHierarchy, mergeMaterials, aggressive, basisUniversal, basisu ? resolvedResizeOpt : 'keep']);
        }

        // parse other options
        let embedTextures = lod.embedTextures ?? defaultEmbedTextures;

        if (basisUniversal !== 'disabled' && embedTextures) {
            if (!warnedEmbeddedBasisu) {
                warnedEmbeddedBasisu = true;
                logger.warn("Basis Universal enabled for model, texture embedding force-disabled; Wonderland Engine doesn't support loading KTX2 textures, so they must be stored externally to be transcoded at runtime");
            }

            embedTextures = false;
        }

        // check if texture cache temp folder is needed
        hasTempCacheDep ||= (resolvedResizeOpt !== 'keep' && basisUniversal === 'disabled');
        hasEmbedded ||= embedTextures;

        if (basisUniversal === 'disabled') {
            nonBasisuCount++;
        }

        // done
        lodsParsed.push([gacIdx, basisu ? 'keep' : resolvedResizeOpt, embedTextures]);
    }

    const gacCount = gltfpackArgCombos.length;
    logger.debug(`There is work to do: ${lodCount} LODs using ${gacCount} gltfpack argument combinations`);

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
            assertFreeFile(resolvePath(outputFolder, `${modelName}-part-0.LOD${l}.glb`));
        }
    }

    // make node IO for gltf-transform
    const io = new PatchedNodeIO();
    io.setLogger(new PrefixedLogger('[glTF-Transform] ', logger));
    io.registerExtensions([ ...KHRONOS_EXTENSIONS, PlaykoExternalWLEMaterial ]);
    io.registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
    });

    // convert model to a format usable by wonderland engine, run gltfpack and
    // generate each lod
    const metadata = <Metadata>{};
    const textureResizer = new TextureResizer(tempFolderPath, hasTempCacheDep && hasEmbedded && nonBasisuCount > 1, logger);

    try {
        let p = 0;
        await wlefyAndSplitModel(logger, io, inputModelPath, tempFolderPath, splitDepth, metadata, async (splitName: string | null, glbPath: string) => {
            const splitSuffix = splitName === null ? ' for model root' : ` for model part "${splitName}"`;

            for (let i = 0; i < gacCount; i++) {
                // run gltfpack
                const gacIdx = i;
                logger.debug(`Running gltfpack on argument combo ${i}${splitSuffix}...`);
                const glbBuf = await simplifyModel(tempFolderPath, gltfpackPath, glbPath, gltfpackArgCombos, gacIdx, logger);

                // get lods that depend on this gltfpack argument combo (gac)
                for (let l = 0; l < lodCount; l++) {
                    const lod = lodsParsed[l];
                    if (gacIdx !== lod[0]) {
                        continue;
                    }

                    logger.debug(`Starting to generate LOD${l}${splitSuffix}...`);
                    const outName = `${modelName}-part-${p}.LOD${l}.glb`;
                    await splitSingleLOD(logger, io, outName, outputFolder, splitName, metadata, gltfpackArgCombos, glbBuf, lod, force, textureResizer);
                }
            }

            p++;
        });

        if (p === 0) {
            if (splitDepth !== 0) {
                throw new Error('No nodes at the wanted split depth; did you specify the right split depth?');
            } else {
                throw new Error('No models were processed. This is most likely a bug, please report it');
            }
        }
    } finally {
        logger.debug('Cleaning up texture resizer cache');
        textureResizer.cleanup();
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