import { VERSION as GLTF_TRANSFORM_VERSION } from '@gltf-transform/core';
import { createTransform } from '@gltf-transform/functions';
import { EXTENSION_NAME } from './extension-name';
import { assertFreeFile } from './assertFreeFile';
import { statSync, writeFileSync } from 'node:fs';
import { imageBufferHash } from './imageBufferHash';
import { resolve as resolvePath } from 'node:path';
import { PlaykoExternalWLEMaterial } from './PlaykoExternalWLEMaterial';
import { PlaykoExternalWLEMaterialReference } from './PlaykoExternalWLEMaterialReference';
import { version as MODEL_SPLITTER_VERSION } from '../../package.json';
import { PrefixedLogger } from './PrefixedLogger';

import type { ConvertedMaterial, ConvertedMaterialTextureName, LOD, Metadata } from './output-types';
import type { GltfpackArgCombo, ParsedLODConfig } from './internal-types';
import type { Document, Texture, Material, ILogger } from '@gltf-transform/core';
import type { PatchedNodeIO } from './PatchedNodeIO';
import type { PackedResizeOption } from './external-types';
import type { TextureResizer } from './TextureResizer';

const TRANS_NAME = 'split-single-lod';

function getDummyMaterial(dummyMaterial: Material | null, gltf: Document): Material {
    return dummyMaterial ? dummyMaterial : gltf.createMaterial();
}

export async function splitSingleLODTransform(textureResizer: TextureResizer, texResizeOpt: PackedResizeOption, embedTextures: boolean, outFolder: string, gltf: Document) {
    const logger = new PrefixedLogger(`${TRANS_NAME}: `, gltf.getLogger());
    const root = gltf.getRoot();
    const graph = gltf.getGraph();

    // embed textures if needed, or move affected materials to metadata file
    // and replace original materials with dummies. resized textures are stored
    // in destination if external, or cached in a temporary folder
    // XXX map contains buffers, then buffer views and their replacements
    const textureHashes = new Map<Texture, string>();
    for (const texture of root.listTextures()) {
        // hash image
        const img = texture.getImage();
        if (img === null) {
            logger.debug('Ignored null image');
            continue;
        }

        const hash = imageBufferHash(img);
        if (hash.endsWith('.ktx2')) {
            logger.debug('Found final basisu image');
            textureResizer.storeExtKTX2(outFolder, img, hash, logger);
            textureHashes.set(texture, hash);
        } else {
            if (!embedTextures && hash.indexOf('.') < 0) {
                logger.warn('Image has an unknown mime-type, so it will be saved with no file extension. This can create issues in some webservers');
            }

            const [resBuf, resHash] = await textureResizer.resizeTexture(outFolder, texResizeOpt, img, hash, embedTextures, logger);

            if (resBuf !== null) {
                // XXX only needed if embedded. if external, resBuf is null to
                // skip this step
                texture.setImage(resBuf);
            }

            textureHashes.set(texture, resHash);
        }
    }

    // handle external textures (convert materials)
    if (!embedTextures) {
        logger.debug('GLTF uses external textures');

        // convert materials to playko format (even if not textured, so that
        // more advanced materials like PBR/semi-transparent are supported)
        const convertedMaterials = gltf.createExtension(PlaykoExternalWLEMaterial);
        const convertedMaterialsMap = new Map<Material, number>();

        for (const material of root.listMaterials()) {
            // check if material depends on an external texture and
            // store hash as reference in converted material
            let hasEmbeddedTexture = false;
            let hasExternalTexture = false;
            const texToCheck: Array<[textureName: ConvertedMaterialTextureName | null, texture: Texture | null, pbrOnly: boolean]> = [
                [null, material.getOcclusionTexture(), false],
                ['emissiveTexture', material.getEmissiveTexture(), false],
                ['normalTexture', material.getNormalTexture(), false],
                ['albedoTexture', material.getBaseColorTexture(), false],
                ['roughnessMetallicTexture', material.getMetallicRoughnessTexture(), true]
            ];

            const convertedMaterial: ConvertedMaterial = {
                pbr: false,
                opaque: true,
            };

            for (const [textureName, texture, pbrOnly] of texToCheck) {
                if (texture === null) {
                    continue;
                }

                const hash = textureHashes.get(texture);
                if (hash === undefined) {
                    hasEmbeddedTexture = true;
                } else {
                    hasExternalTexture = true;

                    if (textureName !== null) {
                        convertedMaterial[textureName] = hash;
                    }

                    if (pbrOnly) {
                        convertedMaterial.pbr = true;
                    }
                }
            }

            if (hasEmbeddedTexture && hasExternalTexture) {
                throw new Error('Material unexpectedly has both embedded and external textures');
            }

            // check transparency
            const alphaMode = material.getAlphaMode();
            if (alphaMode !== 'OPAQUE') {
                convertedMaterial.opaque = false;

                if (alphaMode === 'MASK') {
                    convertedMaterial.alphaMaskThreshold = material.getAlphaCutoff();
                }
            }

            if (!hasExternalTexture && convertedMaterial.opaque && !convertedMaterial.pbr) {
                logger.debug('Material does not depend on external texture, is not a PBR material, and is not semi-transparent. Ignored');
                continue;
            }

            // get extra converted material data
            if (convertedMaterial.emissiveTexture) {
                convertedMaterial.emissiveFactor = material.getEmissiveFactor();
            }

            const albedoFactor = material.getBaseColorFactor();
            if (albedoFactor[0] !== 1 || albedoFactor[1] !== 1 || albedoFactor[2] !== 1 || albedoFactor[3] !== 1) {
                convertedMaterial.albedoFactor = albedoFactor;
                convertedMaterial.pbr = true;
            }

            convertedMaterial.roughnessFactor = material.getRoughnessFactor();
            convertedMaterial.metallicFactor = material.getMetallicFactor();

            // store converted material and remove original material
            const cmID = convertedMaterials.addConvertedMaterial(convertedMaterial);
            convertedMaterialsMap.set(material, cmID);
            logger.debug(`Material marked for removal. Added to converted materials list (converted material id ${cmID})`);
        }

        // replace materials in meshes with converted format and dummy material
        if (convertedMaterials.hasConvertedMaterials()) {
            // replace references to converted materials with custom extension
            let dummyMaterial: Material | null = null;
            const meshes = root.listMeshes();
            const meshCount = meshes.length;

            for (let m = 0; m < meshCount; m++) {
                const mesh = meshes[m];
                const primitives = mesh.listPrimitives();

                for (let p = 0; p < primitives.length; p++) {
                    const primitive = primitives[p];
                    const material = primitive.getMaterial();
                    if (material === null) {
                        continue;
                    }

                    const cmi = convertedMaterialsMap.get(material);
                    if (cmi !== undefined) {
                        logger.debug(`Replaced material for mesh ${m} and primitive ${p} with converted material ${cmi}`);
                        const cmRef = new PlaykoExternalWLEMaterialReference(graph);
                        cmRef.setReplacedMaterial(cmi);
                        primitive.setExtension(EXTENSION_NAME, cmRef);
                        dummyMaterial = getDummyMaterial(dummyMaterial, gltf);
                        primitive.setMaterial(dummyMaterial);
                    }
                }
            }
        }

        // remove materials and textures that were ripped
        for (const material of convertedMaterialsMap.keys()) {
            material.dispose();
        }

        for (const texture of textureHashes.keys()) {
            texture.dispose();
        }
    }

    // remove basisu extension
    if (!embedTextures) {
        for (const extension of root.listExtensionsUsed()) {
            if (extension.extensionName === 'KHR_texture_basisu') {
                extension.dispose();
            }
        }
    }

    // HACK make sure scene is named to prevent crashes in WLE 1.1.6
    const scenes = root.listScenes();
    for (let s = 0; s < scenes.length; s++) {
        const scene = scenes[s];
        if (scene.getName() === '') {
            scene.setName(`scene_${s}`);
        }
    }

    // HACK make sure nodes are named to prevent crashes in WLE 1.1.6
    const nodes = root.listNodes();
    for (let n = 0; n < nodes.length; n++) {
        const node = nodes[n];
        if (node.getName() === '') {
            node.setName(`node_${n}`);
        }
    }

    // override generator
    const asset = root.getAsset();
    asset.generator = `model-splitter ${MODEL_SPLITTER_VERSION} (gltfpack, glTF-Transform ${GLTF_TRANSFORM_VERSION})`;
}

export async function splitSingleLOD(logger: ILogger, io: PatchedNodeIO, outName: string, outFolder: string, metadata: Metadata, gltfpackArgCombos: Array<GltfpackArgCombo>, glbBuf: Uint8Array, lodOptions: ParsedLODConfig, force: boolean, textureResizer: TextureResizer) {
    const outPath = resolvePath(outFolder, outName);
    const [gacIdx, texResizeOpt, embedTextures] = lodOptions;

    // read glb
    logger.debug('Parsing GLB buffer');
    const gltfMain = await io.readBinary(glbBuf);

    // transform glb
    logger.debug('Transforming GLB buffer');
    await gltfMain.transform(createTransform(
        TRANS_NAME,
        splitSingleLODTransform.bind(null, textureResizer, texResizeOpt, embedTextures, outFolder)
    ));

    // save as glb
    logger.debug(`Writing LOD to ${outPath}...`);

    if (!force) {
        assertFreeFile(outPath);
    }

    const outGlbBuf = await io.writeBinary(gltfMain);
    writeFileSync(outPath, outGlbBuf);
    logger.debug('Done writing LOD');

    // update metadata
    const lodMeta: LOD = {
        file: outName,
        lodRatio: gltfpackArgCombos[gacIdx][0],
        bytes: statSync(outPath).size
    };

    if (metadata.lods) {
        metadata.lods.push(lodMeta);
    } else {
        throw new Error('Unexpected missing root in metadata. This is a bug, please report it');
    }

    logger.debug('Done updating metadata');
}