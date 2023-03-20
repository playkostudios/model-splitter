const { gltfToGlb } = require('gltf-pipeline');

import { version } from '../../package.json';
import { EXTENSION_NAME } from './extension-name';
import { assertFreeFile } from './assertFreeFile';
import { statSync, writeFileSync } from 'node:fs';
import { resizeTexture } from './resizeTexture';
import { shiftID } from './shiftID';
import { parseBuffer } from './caching';

import type { IGLTF, ITextureInfo, MaterialAlphaMode } from 'babylonjs-gltf2interface';
import type { ConvertedMaterial, ConvertedMaterialTextureName, Metadata } from './output-types';
import type { GltfpackArgCombo, OriginalImagesList, ParsedLODConfig, ProcessedTextureList } from './internal-types';
import type { Logger } from './Logger';

export async function splitSingleLOD(outName: string, outPath: string, metadata: Metadata, gltfpackArgCombos: Array<GltfpackArgCombo>, gltf: IGLTF, lodOptions: ParsedLODConfig, originalImages: OriginalImagesList, textures: ProcessedTextureList, parsedBuffers: Array<Buffer>, expectedImageCount: number, force: boolean, logger: Logger) {
    const [gacIdx, texResizeOpt, embedTextures] = lodOptions;
    // normalize gltf object
    if (!gltf.images) {
        gltf.images = [];
    }

    if (!gltf.buffers) {
        gltf.buffers = [];
    }

    if (!gltf.bufferViews) {
        gltf.bufferViews = [];
    }

    // embed textures if needed, or move affected materials to metadata file
    // and replace original materials with dummies
    // XXX map contains buffers, then buffer views and their replacements
    const replacedBufferViews = new Map<number, Array<[bufferViewIdx: number, content: Buffer | null, contentHash: string, oldContentLen: number, oldContentOffset: number]>>();
    if (expectedImageCount > 0) {
        for (let i = 0; i < expectedImageCount; i++) {
            const [inBuf, origHash] = originalImages[i];
            const [resBuf, resHash] = await resizeTexture(textures, origHash, texResizeOpt, !embedTextures, inBuf, logger);
            const img = gltf.images[i];

            if (img === undefined) {
                throw new Error(`Unexpected missing image index ${i}`)
            }

            const bufferViewIdx = img.bufferView;

            if (bufferViewIdx === undefined) {
                throw new Error('Unexpected image with no bufferView');
            }

            const bufferView = gltf.bufferViews[bufferViewIdx];
            logger.debug(`${bufferView}`);
            const bufferIdx = bufferView.buffer;
            const bufferLen = bufferView.byteLength;
            const bufferOffset = bufferView.byteOffset ?? 0;

            let bufferViewList = replacedBufferViews.get(bufferIdx);
            if (bufferViewList === undefined) {
                bufferViewList = [];
                replacedBufferViews.set(bufferIdx, bufferViewList);
            }

            bufferViewList.push([bufferViewIdx, embedTextures ? resBuf : null, resHash, bufferLen, bufferOffset]);
        }
    }

    // modify buffers
    for (const [bufferIdx, bufferViewList] of replacedBufferViews) {
        // get buffer views that belong to this buffer and that need to be
        // copied
        const ranges = new Array<[start: number, end: number]>;

        logger.debug('ranges start');
        const bufferViewCount = gltf.bufferViews.length;
        for (let b = 0; b < bufferViewCount; b++) {
            let found = false;
            for (const [ob, _newContent, _hash, _oldContentLength, _oldContentOffset] of bufferViewList) {
                if (b === ob) {
                    found = true;
                    break;
                }
            }

            if (found) {
                continue;
            }

            const bufferView = gltf.bufferViews[b];
            if (bufferView.buffer === bufferIdx) {
                const offset = bufferView.byteOffset ?? 0;
                ranges.push([offset, offset + bufferView.byteLength]);
                logger.debug(`${offset}, ${offset + bufferView.byteLength}`);
            }
        }

        // get contiguous ranges of the original buffer that need to be
        // copied
        ranges.sort((a, b) => a[0] - b[0]);

        for (let v = ranges.length - 1; v >= 1;) {
            const curRange = ranges[v];
            const prevRange = ranges[v - 1];

            if (prevRange[0] <= curRange[1] && prevRange[1] >= curRange[0]) {
                // overlaps! merge and start over
                const newRange: [number, number] = [Math.min(prevRange[0], curRange[0]), Math.max(prevRange[1], curRange[1])];
                ranges.splice(v - 1, 2, newRange);
                v = ranges.length - 1;
            } else {
                v--;
            }
        }

        // get gaps
        const origBuffer = parseBuffer(parsedBuffers, gltf.buffers[bufferIdx]);
        const gaps = new Array<[offset: number, len: number]>;
        if (ranges.length === 0) {
            // buffer was nuked
            gaps.push([0, origBuffer.byteLength]);
        } else {
            // check gap in beginning and end
            const firstRange = ranges[0];
            if (firstRange[0] > 0) {
                gaps.push([0, firstRange[0]]);
            }

            const lastRange = ranges[ranges.length - 1];
            if (lastRange[1] !== origBuffer.byteLength) {
                gaps.push([lastRange[1], origBuffer.byteLength - lastRange[1]]);
            }

            // check gaps between ranges
            for (let r = 1; r < ranges.length; r++) {
                const offset = ranges[r - 1][1];
                const len = ranges[r][0] - offset;
                gaps.push([offset, len]);
            }
        }

        logger.debug('gaps start');
        for (const gap of gaps) {
            logger.debug(`${gap[0]}, ${gap[1]}`);
        }

        // make new buffer
        let newBufSize = 0;
        for (const range of ranges) {
            newBufSize += range[1] - range[0];
        }

        const newOffsets = new Array<number>();
        for (const [_bufferViewIdx, newContent, _hash, _oldContentLength, _oldContentOffset] of bufferViewList) {
            if (newContent) {
                newOffsets.push(newBufSize);
                newBufSize += newContent.byteLength;
            }
        }

        const newBuffer = Buffer.alloc(newBufSize);
        let head = 0;
        for (const range of ranges) {
            origBuffer.copy(newBuffer, head, ...range);
            head += range[1] - range[0];
        }

        for (const [_bufferViewIdx, newContent, _hash, _oldContentLength, _oldContentOffset] of bufferViewList) {
            if (newContent) {
                newContent.copy(newBuffer, head);
                head += newContent.byteLength;
            }
        }

        // apply gap offsets to existing bufferviews
        for (const bufferView of gltf.bufferViews) {
            if (bufferView.buffer !== bufferIdx) {
                continue;
            }

            let byteOffset = bufferView.byteOffset ?? 0;
            for (let g = gaps.length - 1; g >= 0; g--) {
                const gap = gaps[g];
                if (byteOffset >= gap[0]) {
                    byteOffset -= gap[1];
                }
            }

            bufferView.byteOffset = byteOffset;
        }

        // update overridden bufferviews
        const bMax = bufferViewList.length;
        for (let b = 0; b < bMax; b++) {
            const [bufferViewIdx, newContent, _hash, _oldContentLength, _oldContentOffset] = bufferViewList[b];
            const bufferView = gltf.bufferViews[bufferViewIdx];
            logger.debug(`override bufferview ${bufferViewIdx}`);

            if (newContent === null) {
                bufferView.byteLength = 0;
                bufferView.byteOffset = 0;
            } else {
                bufferView.byteLength = newContent.byteLength;
                bufferView.byteOffset = newOffsets[b];
            }
        }

        // replace buffer (encode as base64)
        const buffer = gltf.buffers[bufferIdx];
        buffer.uri = `data:application/octet-stream;base64,${newBuffer.toString('base64')}`;
        buffer.byteLength = newBuffer.byteLength;
    }

    // handle external textures
    if (!embedTextures && gltf.images) {
        // get list of buffer views that were replaced with external
        // textures
        const externalBufferViews = new Map<number, string>();
        for (const bufferViewList of replacedBufferViews.values()) {
            for (const [bufferViewIdx, content, hash, _oldContentLength, _oldContentOffset] of bufferViewList) {
                if (content === null) {
                    externalBufferViews.set(bufferViewIdx, hash);
                    logger.debug(`marked bufferview ${bufferViewIdx} as external`);
                }
            }
        }

        // remove images that use external buffer views
        const externalImages = new Map<number, string>();
        for (let i = gltf.images.length - 1; i >= 0; i--) {
            const image = gltf.images[i];
            const bufferViewIdx = image.bufferView;

            if (bufferViewIdx === undefined) {
                throw new Error('Unexpected image with no bufferView');
            }

            const hash = externalBufferViews.get(bufferViewIdx);
            if (hash !== undefined) {
                gltf.images.splice(i, 1);
                externalImages.set(i, hash);
                logger.debug(`marked image ${i} as external`);
            }
        }

        // remove textures that use external images, track depended samplers
        // and shift image source ids
        const externalTextures = new Map<number, string>();
        const dependedSamplers = new Set<number>();
        if (gltf.textures) {
            for (let t = gltf.textures.length - 1; t >= 0; t--) {
                const texture = gltf.textures[t];
                const hash = externalImages.get(texture.source);

                if (hash !== undefined) {
                    gltf.textures.splice(t, 1);
                    externalTextures.set(t, hash);
                    logger.debug(`marked texture ${t} as external`);
                } else {
                    if (texture.sampler !== undefined) {
                        dependedSamplers.add(texture.sampler);
                    }

                    texture.source = shiftID(texture.source, externalImages.keys());
                }
            }
        }

        // remove, convert and track materials that use external textures
        const convertedMaterials = new Array<ConvertedMaterial>();
        const convertedMaterialsMap = new Map<number, number>();
        if (gltf.materials) {
            for (let m = gltf.materials.length - 1; m >= 0; m--) {
                const material = gltf.materials[m];
                logger.debug(`checking material ${m}`);

                // check if material depends on an external texture and
                // store hash as reference in converted material
                let hasEmbeddedTexture = false;
                let hasExternalTexture = false;
                const texToCheck: Array<[textureName: null | ConvertedMaterialTextureName, textureInfo: ITextureInfo | undefined, pbrOnly: boolean]> = [
                    [null, material.occlusionTexture, false],
                    ['emissiveTexture', material.emissiveTexture, false],
                    ['normalTexture', material.normalTexture, false],
                ];

                const pbr = material.pbrMetallicRoughness;
                if (pbr) {
                    texToCheck.push(['albedoTexture', pbr.baseColorTexture, false]);
                    texToCheck.push(['roughnessMetallicTexture', pbr.metallicRoughnessTexture, true])
                }

                const convertedMaterial: ConvertedMaterial = {
                    pbr: false,
                    opaque: true,
                };

                for (const [textureName, textureInfo, pbrOnly] of texToCheck) {
                    if (textureInfo === undefined) {
                        continue;
                    }

                    const hash = externalTextures.get(textureInfo.index);
                    if (hash === undefined) {
                        hasEmbeddedTexture = true;
                        logger.debug(`found embedded texture ${textureName}`);

                        // shift texture id
                        textureInfo.index = shiftID(textureInfo.index, externalTextures.keys());
                    } else {
                        hasExternalTexture = true;
                        logger.debug(`found external texture ${textureName}`);

                        if (textureName !== null) {
                            convertedMaterial[textureName] = hash;
                        }

                        if (textureInfo.texCoord !== undefined && textureInfo.texCoord !== 0) {
                            throw new Error(`Unsupported texCoord "${textureInfo.texCoord}"; only 0 is supported`);
                        }

                        if (pbrOnly) {
                            convertedMaterial.pbr = true;
                        }
                    }
                }

                if (!hasExternalTexture) {
                    logger.debug(`material had no external textures`);
                    continue;
                }

                if (hasEmbeddedTexture && hasExternalTexture) {
                    throw new Error('Unexpected material with both embedded and external textures');
                }

                // get extra converted material data
                if (material.alphaMode !== undefined && material.alphaMode !== 'OPAQUE') {
                    convertedMaterial.opaque = false;

                    if (material.alphaMode === 'MASK') {
                        convertedMaterial.alphaMaskThreshold = material.alphaCutoff ?? 0.5;
                    }
                }

                if (convertedMaterial.emissiveTexture && material.emissiveFactor) {
                    convertedMaterial.emissiveFactor = material.emissiveFactor;
                }

                if (pbr) {
                    if (convertedMaterial.albedoTexture && pbr.baseColorFactor) {
                        convertedMaterial.albedoFactor = pbr.baseColorFactor;
                        convertedMaterial.pbr = true;
                    }

                    if (convertedMaterial.roughnessMetallicTexture) {
                        convertedMaterial.roughnessFactor = pbr.roughnessFactor ?? 1;
                        convertedMaterial.metallicFactor = pbr.metallicFactor ?? 1;
                    }
                }

                // store converted material and remove original material
                convertedMaterialsMap.set(m, convertedMaterials.length);
                convertedMaterials.push(convertedMaterial);
                gltf.materials.splice(m, 1);
                logger.debug(`material had external textures, converted to ${convertedMaterial}`);
            }
        }

        if (convertedMaterials.length > 0) {
            // replace references to converted materials with custom extension
            let needDummyMaterial = false;
            if (gltf.meshes) {
                for (const mesh of gltf.meshes) {
                    const replacedMaterials = new Array<[primitiveIdx: number, convertedMaterialIdx: number]>();
                    for (let p = 0; p < mesh.primitives.length; p++) {
                        const primitive = mesh.primitives[p];
                        if (primitive.material === undefined) {
                            continue;
                        }

                        const cmi = convertedMaterialsMap.get(primitive.material);
                        if (cmi === undefined) {
                            primitive.material = shiftID(primitive.material, convertedMaterialsMap.keys());
                        } else {
                            replacedMaterials.push([p, cmi]);
                            primitive.material = gltf.materials?.length ?? 0;
                            needDummyMaterial = true;
                        }
                    }

                    if (replacedMaterials.length > 0) {
                        const extension = { replacedMaterials };

                        if (mesh.extensions) {
                            mesh.extensions[EXTENSION_NAME] = extension;
                        } else {
                            mesh.extensions = { [EXTENSION_NAME]: extension };
                        }
                    }
                }
            }

            // create dummy material (meshes without materials are invalid)
            if (needDummyMaterial) {
                if (!gltf.materials) {
                    gltf.materials = [];
                }

                gltf.materials.push({
                    emissiveFactor: [0, 0, 0],
                    alphaMode: 'OPAQUE' as MaterialAlphaMode,
                    doubleSided: false
                });
            }

            // store depended converted materials as root custom extension
            const extension = { convertedMaterials };
            if (gltf.extensions) {
                gltf.extensions[EXTENSION_NAME] = extension;
            } else {
                gltf.extensions = { [EXTENSION_NAME]: extension };
            }

            if (gltf.extensionsUsed) {
                gltf.extensionsUsed.push(EXTENSION_NAME);
            } else {
                gltf.extensionsUsed = [EXTENSION_NAME];
            }
        }

        // remove unused samplers
        if (gltf.samplers) {
            const deletedSamplers = new Set<number>();
            for (let s = gltf.samplers.length - 1; s >= 0; s--) {
                if (!dependedSamplers.has(s)) {
                    deletedSamplers.add(s);
                    gltf.samplers.splice(s, 1);
                }
            }

            // shift sampler ids in textures
            if (gltf.textures) {
                for (const texture of gltf.textures) {
                    if (texture.sampler !== undefined) {
                        texture.sampler = shiftID(texture.sampler, deletedSamplers);
                    }
                }
            }
        }
    }

    logger.debug('done, converting to glb')

    // override generator
    if (gltf.asset.generator === undefined || gltf.asset.generator === '') {
        gltf.asset.generator = `model-splitter ${version}`;
    } else {
        gltf.asset.generator = `model-splitter ${version}, ${gltf.asset.generator}`;
    }

    // remove empty entities
    if (gltf.images.length === 0) {
        delete gltf.images;
    }

    if (gltf.buffers.length === 0) {
        delete gltf.buffers;
    }

    if (gltf.bufferViews.length === 0) {
        delete gltf.bufferViews;
    }

    if (gltf.materials && gltf.materials.length === 0) {
        delete gltf.materials;
    }

    if (gltf.textures && gltf.textures.length === 0) {
        delete gltf.textures;
    }

    if (gltf.samplers && gltf.samplers.length === 0) {
        delete gltf.samplers;
    }

    // save as glb
    if (!force) {
        assertFreeFile(outPath);
    }

    const outGlbBuf = (await gltfToGlb(gltf)).glb;
    logger.debug('done converting, saving')
    writeFileSync(outPath, outGlbBuf);
    logger.debug('done saving, writing to meta')

    // update metadata
    metadata.lods.push({
        file: outName,
        lodRatio: gltfpackArgCombos[gacIdx][0],
        bytes: statSync(outPath).size
    });
    logger.debug('done writing to meta')
}