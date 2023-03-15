const { gltfToGlb, glbToGltf, processGltf } = require('gltf-pipeline');
const gltfpack = require('gltfpack');

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { basename, extname, resolve as resolvePath, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import gm from 'gm';
import { ConsoleLogger } from './ConsoleLogger';
import { createHash } from 'node:crypto';
import { dataUriToBuffer } from 'data-uri-to-buffer';

import type { IGLTF, INode, ITexture, IImage, IMaterial, MaterialAlphaMode, IBuffer } from 'babylonjs-gltf2interface';
import type { ResizeOption } from 'gm';
import type { Logger } from './Logger';

export type ConcreteResizeOption = [width: number, height: number, type?: ResizeOption];
export type PackedResizeOption = ConcreteResizeOption | 'keep';
export type DefaultablePackedResizeOption = PackedResizeOption | 'default';
export type SeparateResources = Record<string, Buffer>;
export type MeshMap = Array<[nodePath: Array<string>, materialID: number]>;
export type LODConfigList = Array<[ meshLODRatio: number, textureResizeOpt: DefaultablePackedResizeOption, keepSceneHierarchy?: boolean | null, noMaterialMerging?: boolean | null ]>;
export type ParsedLODConfigList = Array<[ gltfpackArgCombo: number, textureResizeOpt: PackedResizeOption ]>;
export type GltfpackArgCombo = [meshLODRatio: number, keepSceneHierarchy: boolean, noMaterialMerging: boolean];
export type ProcessedTextureList = Array<[ inputs: Array<[resizeOpt: PackedResizeOption, origHash: string]>, hash: string, content: Buffer, save: boolean ]>;
export type ParsedBufferList = Array<[ gacIdx: number, bufferIdx: number, content: Buffer ]>;

export interface Metadata {
    lods: Array<LOD>,
};

export interface LOD {
    file: string,
    lodRatio: number,
    bytes: number,
};

export interface SplitModelOptions {
    embedTextures?: boolean;
    defaultResizeOpt?: PackedResizeOption;
    defaultKeepSceneHierarchy?: boolean;
    defaultNoMaterialMerging?: boolean;
    force?: boolean;
    logger?: Logger;
};

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

async function parseModel(inputModelPath: string): Promise<{ gltf: IGLTF, separateResources: SeparateResources }> {
    let results;
    if (inputModelPath.endsWith('.gltf')) {
        const modelFile = JSON.parse(readFileSync(inputModelPath).toString());
        results = await processGltf(modelFile, { separateTextures: true });
    } else if (inputModelPath.endsWith('.glb')) {
        const modelFile = readFileSync(inputModelPath);
        results = await glbToGltf(modelFile, { separateTextures: true });
    } else {
        throw new InvalidInputError(`Unknown file extension for path "${inputModelPath}"`);
    }

    return results;
}

function separateTextures(separateResources: Record<string, Buffer>, inTextureList: Array<[relInPath: string, outPath: string]>): void {
    for (const [ relInPath, outPath ] of inTextureList) {
        writeFileSync(outPath, separateResources[relInPath]);
    }
}

function downscaleTexture(inPath: string, outPath: string, resizeOpt: ConcreteResizeOption): Promise<void> {
    return new Promise((resolve, reject) => {
        gm(inPath).resize(...resizeOpt).write(outPath, e => e ? reject(e) : resolve());
    })
}

function traverseNode(meshToNodePath: Map<number, Array<string>>, nodes: Array<INode>, nodePath: Array<string>, node: INode) {
    if (!node.name) {
        return;
    }

    nodePath.push(node.name);

    if (node.mesh !== undefined && !meshToNodePath.has(node.mesh)) {
        meshToNodePath.set(node.mesh, [...nodePath]);
    }

    if (node.children) {
        for (const childIdx of node.children) {
            traverseNode(meshToNodePath, nodes, nodePath, nodes[childIdx]);
        }
    }

    nodePath.pop();
}

function extractMaterials(model: IGLTF, logger: Logger): [textures: Array<ITexture>, images: Array<IImage>, metadata: Metadata] {
    // map nodes to meshes; WLE can't reference meshes directly when loaded via
    // WL.scene.append, so we have to map a scene path to a mesh object
    const meshToNodePath = new Map<number, Array<string>>();
    const nodes = model.nodes === undefined ? [] : model.nodes;
    if (model.scenes !== undefined) {
        for (const scene of model.scenes) {
            for (const rootNodeID of scene.nodes) {
                traverseNode(meshToNodePath, nodes, [], nodes[rootNodeID]);
            }
        }
    }

    // remove material from mesh and map mesh to node path, replace material
    // with bogus material
    const meshMap: Array<[nodePath: Array<string>, materialID: number]> = [];
    const meshes = model.meshes;
    if (meshes) {
        const meshCount = meshes.length;
        for (let i = 0; i < meshCount; i++) {
            let materialID = null;
            for (const primitive of meshes[i].primitives) {
                if (primitive.material !== undefined) {
                    materialID = primitive.material;
                    primitive.material = 0;
                }
            }

            if (materialID === null) {
                logger.warn('Mesh has no material, ignored');
            } else {
                const nodePath = meshToNodePath.get(i);
                if (nodePath === undefined) {
                    logger.warn('Mesh is assigned to nodes that have no named paths, ignored');
                } else {
                    meshMap.push([nodePath, materialID]);
                }
            }
        }
    }

    // extract materials, textures and images, and remove samplers
    delete model.samplers;
    const textures = model.textures ?? [];
    delete model.textures;
    const materials = model.materials ?? [];
    delete model.materials;
    const images = model.images ?? [];
    delete model.images;

    // replace materials list with bogus material
    model.materials = [
        {
            'pbrMetallicRoughness': {
                'metallicFactor': 0.5,
                'roughnessFactor': 0.5,
                'baseColorFactor': [ 1, 1, 1, 1 ]
            },
            'name': 'bogus-material',
            'emissiveFactor': [ 0, 0, 0 ],
            'alphaMode': 'OPAQUE' as MaterialAlphaMode,
            'doubleSided': false
        }
    ];

    return [textures, images, { meshMap, materials }];
}

function makeFriendlyTextureNames(modelName: string, separateResources: SeparateResources, textures?: Array<ITexture>, images?: Array<IImage>): SeparateResources {
    if (textures === undefined || images === undefined) {
        return {};
    }

    // convert textures to friendlier format
    const newResources: SeparateResources = {};
    const textureCount = textures.length;
    for (let i = 0; i < textureCount; i++) {
        const oldURI = images[textures[i].source].uri as string;
        newResources[`${modelName}.TEX${i}${extname(oldURI)}`] = separateResources[oldURI];
    }

    return newResources;
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
    if (val !== null && typeof val === 'object') {
        if (Array.isArray(val)) {
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
    } else {
        return val;
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

export default async function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions = {}) {
    // parse options and get defaults
    let embedTextures = options.embedTextures ?? false;
    let defaultResizeOpt: PackedResizeOption = options.defaultResizeOpt ?? 'keep';
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
        for (let image of images) {
            const bufferView = gltfFirst.bufferViews![image.bufferView!]!;
            const bufferIdx = bufferView.buffer;
            const bufferLen = bufferView.byteLength;
            const bufferOffset = bufferView.byteOffset ?? 0;
            const buffer = parseBuffer(parsedBuffers, gltfFirst.buffers![bufferIdx]);
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

    for (let i = 0; i < lodCount; i++) {
        const [gacIdx, texResizeOpt] = lodsParsed[i];
        const gltf = gltfs[i];

        // embed textures if needed, or move affected materials to metadata file
        // and replace original materials with dummies
        // XXX map contains buffers, then buffer views and their replacements
        const replacedBufferViews = new Map<number, Array<[bufferViewIdx: number, content: Buffer | null, oldContentLen: number, oldContentOffset: number]>>();
        if (expectedImageCount > 0) {
            const images = gltf.images!;
            for (let j = 0; j < expectedImageCount; j++) {
                const [inBuf, origHash] = originalImages[j];
                const [resBuf, resHash] = await resizeTexture(textures, origHash, texResizeOpt, !embedTextures, inBuf, logger);
                const bufferViewIdx = images[j].bufferView!;
                const bufferView = gltfFirst.bufferViews![bufferViewIdx]!;
                const bufferIdx = bufferView.buffer;
                const bufferLen = bufferView.byteLength;
                const bufferOffset = bufferView.byteOffset ?? 0;

                let bufferViewList = replacedBufferViews.get(bufferIdx);
                if (bufferViewList === undefined) {
                    bufferViewList = [];
                    replacedBufferViews.set(bufferIdx, bufferViewList)
                }

                bufferViewList.push([bufferViewIdx, embedTextures ? resBuf : null, bufferLen, bufferOffset]);
                // TODO extract materials, map materials somehow
            }
        }

        logger.debug('old bufferviews');
        let x = 0;
        for (const bufferView of gltf.bufferViews!) {
            logger.debug(`buffer view ${x++}: buffer ${bufferView.buffer}, length ${bufferView.byteLength}, offset ${bufferView.byteOffset ?? 0}`);
        }

        // modify buffers
        const bufferViewCount = gltf.bufferViews?.length ?? 0;
        for (const [bufferIdx, bufferViewList] of replacedBufferViews) {
            // get buffer views that belong to this buffer and that need to be
            // copied
            const ranges = new Array<[start: number, end: number]>;

            logger.debug('ranges start');
            for (let b = 0; b < bufferViewCount; b++) {
                let found = false;
                for (const [ob, _newContent, _oldContentLength, _oldContentOffset] of bufferViewList) {
                    if (b === ob) {
                        found = true;
                        break;
                    }
                }

                if (found) {
                    continue;
                }

                const bufferView = gltf.bufferViews![b];
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
            const origBuffer = parseBuffer(parsedBuffers, gltf.buffers![bufferIdx]);
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
            for (const [_bufferViewIdx, newContent, _oldContentLength, _oldContentOffset] of bufferViewList) {
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

            for (const [_bufferViewIdx, newContent, _oldContentLength, _oldContentOffset] of bufferViewList) {
                if (newContent) {
                    newContent.copy(newBuffer, head);
                    head += newContent.byteLength;
                }
            }

            // apply gap offsets to existing bufferviews
            for (const bufferView of gltf.bufferViews!) {
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
                const [bufferViewIdx, newContent, _oldContentLength, _oldContentOffset] = bufferViewList[b];
                const bufferView = gltf.bufferViews![bufferViewIdx];
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
            const buffer = gltf.buffers![bufferIdx];
            buffer.uri = `data:application/octet-stream;base64,${newBuffer.toString('base64')}`;
            buffer.byteLength = newBuffer.byteLength;
        }

        x = 0;
        for (const bufferView of gltf.bufferViews!) {
            logger.debug(`buffer view ${x++}: buffer ${bufferView.buffer}, length ${bufferView.byteLength}, offset ${bufferView.byteOffset ?? 0}`);
        }

        // save as glb
        const outName = `${modelName}.LOD${i}.glb`;
        const outPath = resolvePath(outputFolder, outName);

        if (!force) {
            assertFreeFile(outPath);
        }

        const outGlbBuf = (await gltfToGlb(gltf)).glb;
        writeFileSync(outPath, outGlbBuf);

        // update metadata
        metadata.lods.push({
            file: outName,
            lodRatio: gltfpackArgCombos[gacIdx][0],
            bytes: statSync(outPath).size
        });
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

async function old__splitModel(tempOutFolder: string, inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions = {}) {
    // parse options
    let embedTextures = options.embedTextures ?? false;
    let defaultResizeOpt: PackedResizeOption = options.defaultResizeOpt ?? 'keep';
    const defaultKeepSceneHierarchy = options.defaultKeepSceneHierarchy ?? false;
    const defaultNoMaterialMerging = options.defaultNoMaterialMerging ?? false;
    let force = options.force ?? false;
    const logger = options.logger ?? new ConsoleLogger();

    // make output folder if needed, or verify that it's a folder
    if (existsSync(outputFolder)) {
        // verify that the output path really is a folder
        if (!statSync(outputFolder).isDirectory()) {
            throw new InvalidInputError(`Output path "${outputFolder}" is not a directory`);
        }
    } else {
        mkdirSync(outputFolder, { recursive: true });
        // XXX folder doesn't exist, no need to prevent file replacing
        force = true;
    }

    // verify that input model exists
    if (!existsSync(inputModelPath)) {
        throw new InvalidInputError(`Input path "${inputModelPath}" does not exist`);
    }

    if (!statSync(inputModelPath).isFile()) {
        throw new InvalidInputError(`Input path "${inputModelPath}" is not a file`);
    }

    // parse model
    const results = await parseModel(inputModelPath);

    let modelName = basename(inputModelPath);
    const extLen = extname(modelName).length;
    if (extLen > 0) {
        modelName = modelName.substring(0, modelName.length - extLen);
    }

    // calculate effective texture resizing for each LOD
    const scaledTextures = new Array<PackedResizeOption>;
    const texGroupMap = new Array<number>();
    for (let i = 0; i < lods.length; i++) {
        const lod = lods[i];
        if (lod[1] === 'default') {
            lod[1] = defaultResizeOpt;
        }

        const jMax = scaledTextures.length;
        let j = 0;
        for (; j < jMax && scaledTextures[j] !== lod[1]; j++);

        if (j === jMax) {
            scaledTextures.push(lod[1]);
        }

        texGroupMap[i] = j;
    }

    // extract materials to metadata object if needed
    let metadata: Metadata;
    if (embedTextures) {
        metadata = {};
        results.separateResources = makeFriendlyTextureNames(modelName, results.separateResources, results.gltf.textures, results.gltf.images);
    } else {
        let textures, images;
        [textures, images, metadata] = extractMaterials(results.gltf, logger);
        results.separateResources = makeFriendlyTextureNames(modelName, results.separateResources, textures, images);
    }

    // generate output paths
    const metadataOutPath = resolvePath(outputFolder, `${modelName}.metadata.json`);

    const lodOutPaths = new Array<[outName: string, outPath: string]>();
    for (let i = 0; i < lods.length; i++) {
        const outName = `${modelName}.LOD${i}.glb`;
        lodOutPaths.push([ outName, resolvePath(outputFolder, outName) ]);
    }

    const textureList = new Array<[relInPath: string, outPath: string]>();
    for (const relativePath of Object.getOwnPropertyNames(results.separateResources)) {
        const outPath = resolvePath(tempOutFolder, relativePath);
        textureList.push([ relativePath, outPath ]);
    }

    const texOutFolder = embedTextures ? tempOutFolder : outputFolder;
    const texGroups = new Array<Array<[outPath: string, outBasename: string]>>();
    for (let i = 0; i < scaledTextures.length; i++) {
        const texGroup = new Array<[outPath: string, outBasename: string]>();

        for (const [origRelInPath, _inPath] of textureList) {
            const ext = extname(origRelInPath);
            const outPath = resolvePath(texOutFolder, `${origRelInPath.substring(0, origRelInPath.length - ext.length)}.SCALE${i}${ext}`);
            texGroup.push([ outPath, basename(outPath) ]);
        }

        texGroups.push(texGroup);
    }

    // verify that there's no file collisions
    if (!force) {
        assertFreeFile(metadataOutPath);

        for (const [_outName, outPath] of lodOutPaths) {
            assertFreeFile(outPath);
        }

        for (const [_outName, outPath] of textureList) {
            assertFreeFile(outPath);
        }

        for (const texGroup of texGroups) {
            for (const [outPath, _outBasename] of texGroup) {
                assertFreeFile(outPath);
            }
        }
    }

    // resize textures and convert metadata
    separateTextures(results.separateResources, textureList);
    const jMax = textureList.length;
    for (let i = 0; i < scaledTextures.length; i++) {
        const resizeOpt = scaledTextures[i];
        const texGroup = texGroups[i];

        for (let j = 0; j < jMax; j++) {
            const inPath = textureList[j][1];
            const outPath = texGroup[j][0];

            if (resizeOpt === 'keep') {
                copyFileSync(inPath, outPath);
            } else {
                await downscaleTexture(inPath, outPath, resizeOpt);
            }
        }
    }

    if (!embedTextures) {
        const bareTexGroups = new Array<Array<string>>();
        for (const texGroup of texGroups) {
            const bareTexGroup = new Array<string>();

            for (const [_outPath, outBasename] of texGroup) {
                bareTexGroup.push(outBasename);
            }

            bareTexGroups.push(bareTexGroup);
        }

        metadata.textureGroups = bareTexGroups;
    }

    // delete input textures
    for (const [_origRelInPath, inPath] of textureList) {
        rmSync(inPath);
    }

    // simplify models for each LOD, add to metadata
    metadata.lods = [];

    if (embedTextures) {
        // make gltfs for each texture group when embedding textures
        const texGroupModels = [];
        const origImages = results.gltf.images ?? [];
        const origBuffers = results.gltf.buffers ?? [];
        const origBufferViews = results.gltf.bufferViews ?? [];

        for (const texGroup of texGroups) {
            const texGroupModel = { ...results.gltf };
            texGroupModel.images = [];
            texGroupModel.buffers = [...origBuffers];
            texGroupModel.bufferViews = [...origBufferViews];

            for (let i = 0; i < texGroup.length; i++) {
                // convert texture to buffer
                const texFileName = texGroup[i][1];

                const bufferIdx = texGroupModel.buffers.length;
                const texBuffer = readFileSync(resolvePath(texOutFolder, texFileName));
                const byteLength = texBuffer.byteLength;
                texGroupModel.buffers.push({
                    name: texFileName,
                    byteLength,
                    uri: `data:application/octet-stream;base64,${texBuffer.toString('base64')}`
                });

                const bufferViewIdx = texGroupModel.bufferViews.length;
                texGroupModel.bufferViews.push({
                    buffer: bufferIdx,
                    byteOffset: 0,
                    byteLength
                });

                const origImage = origImages[i];
                texGroupModel.images.push({
                    bufferView: bufferViewIdx,
                    mimeType: origImage.mimeType,
                    name: origImage.name
                });
            }

            const glbResults = await gltfToGlb(texGroupModel);
            texGroupModels.push(glbResults.glb);
        }

        // simplify model of each texture group
        for (let i = 0; i < lods.length; i++) {
            const [outName, outPath] = lodOutPaths[i];
            const lod = lods[i];
            const lodRatio = lod[0];
            await simplifyModel(
                texGroupModels[texGroupMap[i]], outPath, lodRatio,
                lod[2] ?? defaultKeepSceneHierarchy,
                lod[3] ?? defaultNoMaterialMerging,
                logger
            );

            metadata.lods.push({
                file: outName,
                lodRatio,
                bytes: statSync(outPath).size
            });
        }
    } else {
        // simplify model
        const glbResults = await gltfToGlb(results.gltf);
        const glbModel = glbResults.glb;

        for (let i = 0; i < lods.length; i++) {
            const [outName, outPath] = lodOutPaths[i];
            const lod = lods[i];
            const lodRatio = lod[0];
            let noMaterialMerging = lod[3] ?? defaultNoMaterialMerging;

            if (!noMaterialMerging) {
                logger.warn(`Material merging force-disabled for LOD${i}; embedded textures are disabled, so materials can't be merged`);
                noMaterialMerging = true;
            }

            await simplifyModel(
                glbModel, outPath, lodRatio,
                lod[2] ?? defaultKeepSceneHierarchy,
                noMaterialMerging, logger
            );

            metadata.lods.push({
                file: outName,
                lodRatio,
                textureGroup: texGroupMap[i],
                bytes: statSync(outPath).size
            });
        }
    }

    // write metadata
    writeFileSync(metadataOutPath, JSON.stringify(metadata));
}

async function old_splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options?: SplitModelOptions) {
    // make temporary folder. automatically removed on exit
    const tempOutFolder = mkdtempSync(joinPath(tmpdir(), 'model-splitter-'));

    try {
        return await old__splitModel(tempOutFolder, inputModelPath, outputFolder, lods, options);
    } finally {
        rmSync(tempOutFolder, { recursive: true, force: true });
    }
}