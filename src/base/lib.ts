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

import type { InstanceGroup, Metadata } from './output-types';
import { DEFAULT_INSTANCE_GROUP_FORMAT, GltfpackArgCombo, InstanceGroupFormat, ParsedLODConfigList } from './internal-types';
import type { LODConfigList, PackedResizeOption, SplitModelOptions } from './external-types';
import { quat, vec3 } from 'gl-matrix';
import { naturalListToString } from './naturalListToString';
import { writeInstanceGroup_ModelSplitter_V1 } from './writeInstanceGroup_ModelSplitter_V1';
import { writeInstanceGroup_RP1Blueprint_V1 } from './writeInstanceGroup_RP1Blueprint_V1';

export * from './ModelSplitterError';
export * from './external-types';

function resetTransformToString(resetPosition: boolean, resetRotation: boolean, resetScale: boolean): string {
    const parts = [];
    if (resetPosition) {
        parts.push('positions');
    }
    if (resetRotation) {
        parts.push('rotations');
    }
    if (resetScale) {
        parts.push('scales');
    }

    return naturalListToString(parts);
}

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
    const resetPosition = options.resetPosition ?? false;
    const resetRotation = options.resetRotation ?? false;
    const resetScale = options.resetScale ?? false;
    const instanceGroupFormat = (options.createInstanceGroup ?? false) ? (options.instanceGroupFormat ?? DEFAULT_INSTANCE_GROUP_FORMAT) : null;
    const discardDepthSplitParentNodes = options.discardDepthSplitParentNodes ?? false;

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

    // make node IO for gltf-transform
    const io = new PatchedNodeIO();
    io.setLogger(new PrefixedLogger('[glTF-Transform] ', logger));
    io.registerExtensions([ ...KHRONOS_EXTENSIONS, PlaykoExternalWLEMaterial ]);
    io.registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
    });

    // convert model to a format usable by wonderland engine, run gltfpack,
    // generate each lod, write metadata file for parts, and create placements
    // for parts
    const textureResizer = new TextureResizer(tempFolderPath, hasTempCacheDep && hasEmbedded && nonBasisuCount > 1, logger);

    try {
        let instanceGroup: InstanceGroup | null = null;
        const groupOutPath = resolvePath(outputFolder, `${modelName}.group-metadata.json`);
        if (instanceGroupFormat !== null) {
            instanceGroup = {
                name: modelName,
                sources: [],
                instances: [],
            };

            // check if instance group destination is free (double-checked
            // later)
            if (!force) {
                assertFreeFile(groupOutPath);
            }

            // warn about useless instance group settings, which might not be
            // what the user wants
            if (splitDepth === 0) {
                logger.warn('Instance group will be created, but no depth-splitting is being done. This might be a mistake; you will get an instance group with just one instance');
            } else if (!(resetPosition && resetRotation && resetScale)) {
                logger.warn(`Instance group will be created, but ${resetTransformToString(!resetPosition, !resetRotation, !resetScale)} are not being reset. This might be a mistake; you will probably get one model per instance, instead of multiple instances reusing the same model`);
            }
        }

        // warn about transform reset/parent node discard + no depth splitting
        // behaviour
        if (splitDepth === 0) {
            if (discardDepthSplitParentNodes) {
                logger.warn('No depth-splitting is being done, but depth-split parent nodes is enabled. Option will have no effect');
            }

            if (resetPosition || resetRotation || resetScale) {
                logger.warn(`No depth-splitting is being done, but ${resetTransformToString(resetPosition, resetRotation, resetScale)} are being reset. This might be a mistake; when resetting transforms with no depth, the depth is treated as 1, but the model isn't split, meaning that children of the scene root will have their transforms reset`);

                if (resetPosition && resetRotation && resetScale) {
                    logger.warn('The current settings will result in a catalogue model; a model with multiple sub-models at the root of the scene, similar to how SVG stacks work. Note that you are responsible for deduplicating the sub-models in the input model');
                } else {
                    logger.warn('Unless you have a very good reason to do this, you will most likely just ruin the scene graph');
                }
            }
        }

        // process parts
        let hadParts = false;
        const sourceMetadata = new Array<Metadata>(); // only populated if generating instance groups
        await wlefyAndSplitModel(logger, io, inputModelPath, tempFolderPath, splitDepth, discardDepthSplitParentNodes, resetPosition, resetRotation, resetScale, async (splitNameSuffix: string | null, glbPath: string, metadata: Metadata) => {
            hadParts = true;
            const splitSuffix = splitNameSuffix === null ? 'for model root' : `for model part "${splitNameSuffix}"`;
            const finalPartName = splitNameSuffix === null ? modelName : `${modelName}-${splitNameSuffix}`;
            const metaOutFileName = `${finalPartName}.metadata.json`;
            const metaOutPath = resolvePath(outputFolder, metaOutFileName);

            // check if metadata destination is free (double-checked later)
            if (!force) {
                assertFreeFile(metaOutPath);
            }

            // process lods
            for (let i = 0; i < gacCount; i++) {
                // run gltfpack
                const gacIdx = i;
                logger.debug(`Running gltfpack on argument combo ${i} ${splitSuffix}...`);
                const glbBuf = await simplifyModel(tempFolderPath, gltfpackPath, glbPath, gltfpackArgCombos, gacIdx, logger);

                // get lods that depend on this gltfpack argument combo (gac)
                for (let l = 0; l < lodCount; l++) {
                    const lod = lodsParsed[l];
                    if (gacIdx !== lod[0]) {
                        continue;
                    }

                    const outName = `${finalPartName}.LOD${l}.glb`;
                    logger.debug(`Generating LOD${l} ${splitSuffix} ("${outName}"")...`);
                    await splitSingleLOD(logger, io, outName, outputFolder, metadata, gltfpackArgCombos, glbBuf, lod, force, textureResizer);
                }
            }

            // write metadata to final destination
            logger.debug(`Writing metadata file ${splitSuffix} ("${metaOutPath}")...`);

            if (!force) {
                assertFreeFile(metaOutPath);
            }

            writeFileSync(metaOutPath, JSON.stringify(metadata));

            if (instanceGroup) {
                const sources = instanceGroup.sources;
                sources.push(metaOutFileName);
                sourceMetadata.push(metadata);
                return sources.length - 1;
            } else {
                return -1;
            }
        }, (nullableSource: number | null, nullableParent: number | null, name: string, position: vec3, rotation: quat, scale: vec3) => {
            if (instanceGroup === null) {
                return -1;
            }

            // XXX null source represents a node with no mesh, used for parent
            //     nodes when depth-splitting, or dummy nodes used for
            //     correcting the transform of a mesh that didn't have its
            //     transforms reset
            instanceGroup.instances.push({
                name, position, rotation, scale,
                source: nullableSource ?? undefined,
                parent: nullableParent ?? undefined
            });

            return instanceGroup.instances.length - 1;
        });

        if (!hadParts) {
            if (splitDepth !== 0) {
                throw new Error('No nodes at the wanted split depth; did you specify the right split depth?');
            } else {
                throw new Error('No models were processed. This is most likely a bug, please report it');
            }
        }

        if (instanceGroup) {
            logger.debug(`Writing instance group file ("${groupOutPath}") using format "${instanceGroupFormat}"...`);

            if (!force) {
                assertFreeFile(groupOutPath);
            }

            switch(instanceGroupFormat!) {
            case InstanceGroupFormat.RP1Blueprint_V1:
                writeInstanceGroup_RP1Blueprint_V1(groupOutPath, instanceGroup, sourceMetadata);
                break;
            default:
                writeInstanceGroup_ModelSplitter_V1(groupOutPath, instanceGroup);
            }
        }
    } finally {
        logger.debug('Cleaning up texture resizer cache');
        textureResizer.cleanup();
    }

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