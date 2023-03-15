const { gltfToGlb, glbToGltf } = require('gltf-pipeline');
const gltfpack = require('gltfpack');

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { basename, extname, resolve as resolvePath } from 'node:path';
import gm from 'gm';
import { ConsoleLogger } from './ConsoleLogger';
import { createHash } from 'node:crypto';
import { dataUriToBuffer } from 'data-uri-to-buffer';
import { version } from '../package.json';

import type { IGLTF, IImage, IBuffer, ITextureInfo, MaterialAlphaMode } from 'babylonjs-gltf2interface';
import type { ResizeOption } from 'gm';
import type { Logger } from './Logger';

export const EXTENSION_NAME = 'PLAYKO_EXTERNAL_WLE_MATERIAL';

type ParsedLODConfigList = Array<[ gltfpackArgCombo: number, textureResizeOpt: PackedResizeOption ]>;
type GltfpackArgCombo = [meshLODRatio: number, keepSceneHierarchy: boolean, noMaterialMerging: boolean];
type ProcessedTextureList = Array<[ inputs: Array<[resizeOpt: PackedResizeOption, origHash: string]>, hash: string, content: Buffer, save: boolean ]>;

export type ConcreteResizeOption = [width: number, height: number, type?: ResizeOption];
export type PackedResizeOption = ConcreteResizeOption | 'keep';
export type DefaultablePackedResizeOption = PackedResizeOption | 'default';
export type LODConfigList = Array<[ meshLODRatio: number, textureResizeOpt: DefaultablePackedResizeOption, keepSceneHierarchy?: boolean | null, noMaterialMerging?: boolean | null ]>;

export interface ConvertedMaterial {
    pbr: boolean;
    opaque: boolean;
    normalTexture?: string,
    albedoTexture?: string,
    emissiveTexture?: string,
    roughnessMetallicTexture?: string,
    albedoFactor?: number[],
    emissiveFactor?: number[],
    alphaMaskThreshold?: number,
    metallicFactor?: number,
    roughnessFactor?: number,
}

export interface Metadata {
    lods: Array<LOD>,
}

export interface LOD {
    file: string,
    lodRatio: number,
    bytes: number,
}

export interface SplitModelOptions {
    embedTextures?: boolean;
    defaultResizeOpt?: PackedResizeOption;
    defaultKeepSceneHierarchy?: boolean;
    defaultNoMaterialMerging?: boolean;
    force?: boolean;
    logger?: Logger;
}

export class ModelSplitterError<T extends string> extends Error {
    isModelSplitterError = true;

    constructor(desc: string, public modelSplitterType: T) {
        super(desc);
    }
}

export class CollisionError extends ModelSplitterError<'collision'> {
    constructor(filePath: string) {
        super(`File "${filePath}" already exists`, 'collision');
    }
}

export class InvalidInputError extends ModelSplitterError<'invalid-input'> {
    constructor(desc: string) {
        super(`Invalid input: ${desc}`, 'invalid-input');
    }
}

async function simplifyModel(modelBuffer: Buffer, isGLTF: boolean, lodRatio: number, keepSceneHierarchy: boolean, noMaterialMerging: boolean, logger: Logger): Promise<Uint8Array> {
    // build argument list
    const inputPath = `argument://input-model.gl${isGLTF ? 'tf' : 'b'}`;
    const outputPath = 'argument://output-model.glb';
    const args = ['-i', inputPath, '-o', outputPath, '-noq'];

    if (keepSceneHierarchy) {
        args.push('-kn');
    }

    if (noMaterialMerging) {
        args.push('-km')
    }

    if (lodRatio < 1) {
        if (lodRatio <= 0) {
            throw new InvalidInputError('LOD levels must be greater than 0');
        }

        args.push('-si', `${lodRatio}`);
    } else if (lodRatio > 1) {
        logger.warn('Ignored LOD ratio greater than 1; treating as 1 (no simplification)');
    }

    // simplify
    let output: Uint8Array | null = null;
    const log = await gltfpack.pack(args, {
        read: (filePath: string) => {
            if (filePath === inputPath) {
                return modelBuffer;
            } else {
                return readFileSync(filePath);
            }
        },
        write: (filePath: string, data: Uint8Array) => {
            if (filePath === outputPath) {
                output = data;
            } else {
                logger.warn(`Ignored unexpected gltfpack file write to path "${filePath}"`);
            }
        },
    });

    // extract output
    if (log !== '') {
        logger.log(log);
    }

    if (output === null) {
        throw new Error('gltfpack had no output');
    }

    return output;
}

function assertFreeFile(filePath: string) {
    if (existsSync(filePath)) {
        throw new CollisionError(filePath);
    }
}

function deepClone<T>(val: T): T {
    if (val === null || typeof val === 'object') {
        return val;
    } else if (Array.isArray(val)) {
        const outVal = [] as T;

        for (const subVal of val) {
            (outVal as Array<unknown>).push(deepClone(subVal));
        }

        return outVal;
    } else {
        const outVal: Record<string, unknown> = {};

        for (const name of Object.getOwnPropertyNames(val)) {
            outVal[name] = deepClone((val as Record<string, unknown>)[name]);
        }

        return outVal as T;
    }
}

function parseBuffer(parsedBuffers: Array<Buffer>, buffer: IBuffer): Buffer {
    // validate buffer
    if (buffer === undefined) {
        throw new Error('Unexpected missing buffer');
    }

    // check if already parsed or parse
    if (typeof buffer.uri === 'number') {
        // already parsed
        return parsedBuffers[buffer.uri];
    } else if (typeof buffer.uri === 'string') {
        // data URI
        const bufParsed = dataUriToBuffer(buffer.uri);
        const pBufIdx = parsedBuffers.length;
        parsedBuffers.push(bufParsed);
        // HACK replace uri with index for parsedBuffers
        (buffer.uri as unknown as number) = pBufIdx;
        return bufParsed;
    } else {
        throw new Error('Unexpected buffer URI value');
    }
}

function bufferHash(buffer: Buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function getProcessedTexture(textures: ProcessedTextureList, origHash: string, hash: string, buffer: Buffer, resizeOpt: PackedResizeOption): Buffer {
    for (let i = 0; i < textures.length; i++) {
        const texture = textures[i];
        if (hash === texture[1]) {
            return texture[2];
        }
    }

    textures.push([[[resizeOpt, origHash]], hash, buffer, false]);
    return buffer;
}

function resizeOptMatches(a: PackedResizeOption, b: PackedResizeOption) {
    return a === b || (a[0] === b[0] && a[1] === b[1] && (a[2] ?? '!') === (b[2] ?? '!'));
}

function resizeTexture(textures: ProcessedTextureList, origHash: string, resizeOpt: PackedResizeOption, save: boolean, inBuf: Buffer, logger: Logger): Promise<[buffer: Buffer, hash: string]> {
    return new Promise((resolve, reject) => {
        // check if this resize operation has already been done
        for (let i = 0; i < textures.length; i++) {
            const [oInputs, oHash, oBuffer, _save] = textures[i];

            for (const [oResizeOpt, oOrigHash] of oInputs) {
                if (origHash === oOrigHash && resizeOptMatches(oResizeOpt, resizeOpt)) {
                    if (save) {
                        textures[i][3] = true;
                    }

                    resolve([oBuffer, oHash]);
                    return;
                }
            }
        }

        if (resizeOpt === 'keep') {
            throw new Error('No match despite resizeOpt being "keep"');
        }

        // none of the inputs match, call graphicsmagick
        gm(inBuf).resize(...resizeOpt).toBuffer((err, outBuf) => {
            if (err === null) {
                const outHash = bufferHash(outBuf);

                // check if this resize operation has already been done, but
                // only the output matches
                for (let i = 0; i < textures.length; i++) {
                    const [oInputs, oHash, oBuffer, _save] = textures[i];

                    if (outHash === oHash) {
                        if (save) {
                            textures[i][3] = true;
                        }

                        logger.warn(`Resize option is equivalent to another resize option, but this is not obvious. Try to write resize options in a normalized way to minimise repeated work`);
                        oInputs.push([resizeOpt, origHash]);
                        resolve([oBuffer, oHash]);
                        return;
                    }
                }

                // none of the outputs match, add to processed textures list
                textures.push([[[resizeOpt, origHash]], outHash, outBuf, save]);
                resolve([outBuf, outHash]);
            } else {
                reject(err);
            }
        });
    });
}

function shiftID(origID: number, deletedIDs: Iterable<number>): number {
    let newID = origID;
    for (const deletedID of deletedIDs) {
        if (origID > deletedID) {
            newID--;
        }
    }

    return newID;
}

export default async function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions = {}) {
    // parse options and get defaults
    const embedTextures = options.embedTextures ?? false;
    const defaultResizeOpt: PackedResizeOption = options.defaultResizeOpt ?? 'keep';
    const defaultKeepSceneHierarchy = options.defaultKeepSceneHierarchy ?? false;
    const defaultNoMaterialMerging = options.defaultNoMaterialMerging ?? false;
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
        if (lod[1] === 'default') {
            resolvedResizeOpt = defaultResizeOpt;
        } else if (Array.isArray(lod[1])) {
            const concreteResOpts = lod[1];
            if (concreteResOpts[2] === '%' && concreteResOpts[0] === 100 && concreteResOpts[1] === 100) {
                resolvedResizeOpt = 'keep';
            } else {
                resolvedResizeOpt = concreteResOpts;
            }
        } else {
            resolvedResizeOpt = lod[1];
        }

        // parse gltfpack options
        const lodRatio = lod[0];
        const keepSceneHierarchy = lod[2] ?? defaultKeepSceneHierarchy;
        const noMaterialMerging = lod[3] ?? defaultNoMaterialMerging;

        let gacIdx = 0;
        const gacCount = gltfpackArgCombos.length;
        for (; gacIdx < gacCount; gacIdx++) {
            const gac = gltfpackArgCombos[gacIdx];
            if (gac[0] === lodRatio && gac[1] === keepSceneHierarchy && gac[2] === noMaterialMerging) {
                break;
            }
        }

        if (gacIdx === gacCount) {
            gltfpackArgCombos.push([lodRatio, keepSceneHierarchy, noMaterialMerging]);
        }

        // done
        lodsParsed.push([gacIdx, resolvedResizeOpt]);
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

    // run gltfpack
    const gacCount = gltfpackArgCombos.length;
    const origInputModel = readFileSync(inputModelPath);
    const gltfpackOutputs = new Array<IGLTF>(gacCount);
    const gltfpackPromises = new Array<Promise<void>>();

    for (let i = 0; i < gacCount; i++) {
        const gacIdx = i;
        gltfpackPromises.push(new Promise<void>((resolve, reject) => {
            simplifyModel(origInputModel, false, ...gltfpackArgCombos[gacIdx], logger).then(buf => {
                return glbToGltf(buf);
            }).then(results => {
                if (results.separateResources && Object.getOwnPropertyNames(results.separateResources).length > 0) {
                    throw new Error('Unexpected external resources in GLTF');
                }

                if (!results.gltf) {
                    throw new Error('Unexpected missing GLTF in gltf-pipeline output');
                }

                gltfpackOutputs[gacIdx] = results.gltf;
                resolve();
            }).catch(reject);
        }));
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
    const originalImages = new Array<[buffer: Buffer, origHash: string]>();
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

    // extract model name
    let modelName = basename(inputModelPath);
    const extLen = extname(modelName).length;
    if (extLen > 0) {
        modelName = modelName.substring(0, modelName.length - extLen);
    }

    // generate each lod
    // WARNING this assumes that every output packed gltf has the same images at
    //         the same indices
    const metadata: Metadata = {
        lods: []
    };

    for (let l = 0; l < lodCount; l++) {
        logger.debug(`starting lod ${l}`)
        const [gacIdx, texResizeOpt] = lodsParsed[l];
        const gltf = gltfs[l];

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
                const bufferViewIdx = gltf.images[i].bufferView;

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
                    const texToCheck: Array<[textureName: null | 'emissiveTexture' | 'normalTexture' | 'albedoTexture' | 'roughnessMetallicTexture', textureInfo: ITextureInfo | undefined, pbrOnly: boolean]> = [
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

                if (gltf.extensionsRequired) {
                    gltf.extensionsRequired.push(EXTENSION_NAME);
                } else {
                    gltf.extensionsRequired = [EXTENSION_NAME];
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
        const outName = `${modelName}.LOD${l}.glb`;
        const outPath = resolvePath(outputFolder, outName);

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

    // write non-embedded textures to final destination
    for (const [_inputs, hash, content, save] of textures) {
        if (!save) {
            continue;
        }

        const outPath = resolvePath(outputFolder, hash);

        if (!force) {
            assertFreeFile(outPath);
        }

        writeFileSync(outPath, content);
    }

    // write metadata to final destination
    const outPath = resolvePath(outputFolder, `${modelName}.metadata.json`);

    if (!force) {
        assertFreeFile(outPath);
    }

    writeFileSync(outPath, JSON.stringify(metadata));
}
