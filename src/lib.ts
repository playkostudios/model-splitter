const { gltfToGlb, glbToGltf, processGltf } = require('gltf-pipeline');
const gltfpack = require('gltfpack');

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { basename, extname, resolve as resolvePath, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import gm from 'gm';
import { ConsoleLogger } from './Logger';

import type { IGLTF, INode, ITexture, IImage, IMaterial, MaterialAlphaMode } from 'babylonjs-gltf2interface';
import type { ResizeOption } from 'gm';
import type { Logger } from './Logger';

export type ConcreteResizeOption = [width: number, height: number, type?: ResizeOption];
export type PackedResizeOption = ConcreteResizeOption | 'keep';
export type DefaultablePackedResizeOption = PackedResizeOption | 'default';
export type SeparateResources = Record<string, Buffer>;
export type MeshMap = Array<[nodePath: Array<string>, materialID: number]>;
export type LODConfigList = Array<[ meshLODRatio: number, textureResizeOpt: DefaultablePackedResizeOption, keepSceneHierarchy?: boolean | null, noMaterialMerging?: boolean | null ]>;

export interface Metadata {
    meshMap?: MeshMap,
    materials?: Array<IMaterial>,
    textureGroups?: Array<Array<string>>,
    lods?: Array<LOD>,
};

export interface LOD {
    file: string,
    lodRatio: number,
    bytes: number,
    textureGroup?: number,
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

async function simplifyModel(modelBuffer: Buffer, modelOutPath: string, lodRatio: number, keepSceneHierarchy: boolean, noMaterialMerging: boolean, logger: Logger) {
    const inputPath = 'argument://input-model.glb';
    const gltfpackInterface = {
        read: (filePath: string) => {
            if (filePath === inputPath) {
                return modelBuffer;
            } else {
                return readFileSync(filePath);
            }
        },
        write: writeFileSync,
    };

    const args = ['-i', inputPath, '-o', modelOutPath, '-noq'];

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

    const log = await gltfpack.pack(args, gltfpackInterface);
    if (log !== '') {
        logger.log(log);
    }
}

function assertFreeFile(filePath: string) {
    if (existsSync(filePath)) {
        throw new CollisionError(filePath);
    }
}

async function _splitModel(tempOutFolder: string, inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions = {}) {
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
            const lodRatio = lods[i][0];
            await simplifyModel(texGroupModels[texGroupMap[i]], outPath, lodRatio, keepSceneHierarchy, noMaterialMerging, logger);

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
            const lodRatio = lods[i][0];
            await simplifyModel(glbModel, outPath, lodRatio, keepSceneHierarchy, noMaterialMerging, logger);

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

export default async function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options?: SplitModelOptions) {
    // make temporary folder. automatically removed on exit
    const tempOutFolder = mkdtempSync(joinPath(tmpdir(), 'model-splitter-'));

    try {
        return await _splitModel(tempOutFolder, inputModelPath, outputFolder, lods, options);
    } finally {
        rmSync(tempOutFolder, { recursive: true, force: true });
    }
}