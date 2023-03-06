const { gltfToGlb, glbToGltf, processGltf } = require('gltf-pipeline');
const gltfpack = require('gltfpack');

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { basename, extname, resolve as resolvePath } from 'node:path';
import gm from 'gm';

import type { IGLTF, INode, ITexture, IImage, IMaterial, MaterialAlphaMode } from 'babylonjs-gltf2interface';
import type { ResizeOption } from 'gm';

export type PackedResizeOption = [width: number, height: number, type?: ResizeOption];
export type SeparateResources = Record<string, Buffer>;
export type MeshMap = Array<[nodePath: Array<string>, materialID: number]>;
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
}
export type LODConfigList = Array<[ meshLODRatio: number, textureResizeOpt: PackedResizeOption | null ]>;

async function parseModel(inputModelPath: string): Promise<{ gltf: IGLTF, separateResources: SeparateResources }> {
    let results;
    if (inputModelPath.endsWith('.gltf')) {
        const modelFile = JSON.parse(readFileSync(inputModelPath).toString());
        results = await processGltf(modelFile, { separateTextures: true });
    } else if (inputModelPath.endsWith('.glb')) {
        const modelFile = readFileSync(inputModelPath);
        results = await glbToGltf(modelFile, { separateTextures: true });
    } else {
        throw new Error(`Unknown file extension for path "${inputModelPath}"`);
    }

    return results;
}

function separateTextures(separateResources: Record<string, Buffer>, outputFolder: string): Array<string> {
    const textureList = [];
    for (const relativePath in separateResources) {
        if (separateResources.hasOwnProperty(relativePath)) {
            const resource = separateResources[relativePath];
            const outPath = resolvePath(outputFolder, relativePath);
            textureList.push(outPath);
            writeFileSync(outPath, resource);
        }
    }

    return textureList;
}

function downscaleTexture(inPath: string, outPath: string, resizeOpt: PackedResizeOption): Promise<void> {
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

function extractMaterials(model: IGLTF): [textures: Array<ITexture>, images: Array<IImage>, metadata: Metadata] {
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
                console.warn('Mesh has no material, ignored');
            } else {
                const nodePath = meshToNodePath.get(i);
                if (nodePath === undefined) {
                    console.warn('Mesh is assigned to nodes that have no named paths, ignored');
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

async function simplifyModel(modelBuffer: Buffer, modelOutPath: string, lodRatio: number) {
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

    const args = ['-i', inputPath, '-o', modelOutPath, '-noq', '-kn', '-km'];

    if (lodRatio < 1) {
        if (lodRatio <= 0) {
            throw new Error('LOD levels must be greater than 0');
        }

        args.push('-si', `${lodRatio}`);
    } else if (lodRatio > 1) {
        console.warn('Ignored LOD ratio greater than 1; treating as 1 (no simplification)');
    }

    const log = await gltfpack.pack(args, gltfpackInterface);
    if (log !== '') {
        console.log(log);
    }
}

export default async function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, embedTextures = false, defaultResizeOpt: PackedResizeOption | null = null) {
    // make output folder
    mkdirSync(outputFolder, { recursive: true });

    // parse model
    const results = await parseModel(inputModelPath);

    let modelName = basename(inputModelPath);
    const extLen = extname(modelName).length;
    if (extLen > 0) {
        modelName = modelName.substring(0, modelName.length - extLen);
    }

    // calculate effective texture resizing for each LOD
    const scaledTextures = new Array<PackedResizeOption | null>;
    const texGroupMap = new Array<number>();
    for (let i = 0; i < lods.length; i++) {
        const lod = lods[i];
        if (lod[1] === null) {
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
        [textures, images, metadata] = extractMaterials(results.gltf);
        results.separateResources = makeFriendlyTextureNames(modelName, results.separateResources, textures, images);
    }

    // resize textures and convert metadata
    const textureList = separateTextures(results.separateResources, outputFolder);
    const texGroups = [];
    for (let i = 0; i < scaledTextures.length; i++) {
        const resizeOpt = scaledTextures[i];
        const texGroup = [];

        for (const inPath of textureList) {
            const ext = extname(inPath);
            const outPath = `${inPath.substring(0, inPath.length - ext.length)}.SCALE${i}${ext}`;
            texGroup.push(basename(outPath));

            if (resizeOpt === null) {
                copyFileSync(inPath, outPath);
            } else {
                await downscaleTexture(inPath, outPath, resizeOpt);
            }
        }

        texGroups.push(texGroup);
    }

    if (!embedTextures) {
        metadata.textureGroups = texGroups;
    }

    // delete input textures
    for (const inPath of textureList) {
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
                const texFileName = texGroup[i];

                const bufferIdx = texGroupModel.buffers.length;
                const texBuffer = readFileSync(resolvePath(outputFolder, texFileName));
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

        // delete textures
        for (const texGroup of texGroups) {
            for (const texturePath of texGroup) {
                rmSync(resolvePath(outputFolder, texturePath));
            }
        }

        // simplify model of each texture group
        for (let i = 0; i < lods.length; i++) {
            const outName = `${modelName}.LOD${i}.glb`;
            const outPath = resolvePath(outputFolder, outName);
            const lodRatio = lods[i][0];
            await simplifyModel(texGroupModels[texGroupMap[i]], outPath, lodRatio);

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
            const outName = `${modelName}.LOD${i}.glb`;
            const outPath = resolvePath(outputFolder, outName);
            const lodRatio = lods[i][0];
            await simplifyModel(glbModel, outPath, lodRatio);

            metadata.lods.push({
                file: outName,
                lodRatio,
                textureGroup: texGroupMap[i],
                bytes: statSync(outPath).size
            });
        }
    }

    // write metadata
    writeFileSync(resolvePath(outputFolder, `${modelName}.metadata.json`), JSON.stringify(metadata));
}
