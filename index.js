const gltf = require('gltf-pipeline');
const fs = require('node:fs');
const path = require('node:path');
const gm = require('gm');
const gltfpack = require('gltfpack');

async function parseModel(inputModelPath) {
    let results;
    if (inputModelPath.endsWith('.gltf')) {
        const modelFile = JSON.parse(fs.readFileSync(inputModelPath).toString());
        results = await gltf.processGltf(modelFile, { separateTextures: true });
    } else if (inputModelPath.endsWith('.glb')) {
        const modelFile = fs.readFileSync(inputModelPath);
        results = await gltf.glbToGltf(modelFile, { separateTextures: true });
    } else {
        throw new Error(`Unknown file extension for path "${inputModelPath}"`);
    }

    return results;
}

function separateTextures(separateResources, outputFolder) {
    const textureList = [];
    for (const relativePath in separateResources) {
        if (separateResources.hasOwnProperty(relativePath)) {
            const resource = separateResources[relativePath];
            const outPath = path.resolve(outputFolder, relativePath);
            textureList.push(outPath);
            fs.writeFileSync(outPath, resource);
        }
    }

    return textureList;
}

function downscaleTexture(inPath, outPath, resizeOpt) {
    return new Promise((resolve, reject) => {
        gm(inPath).resize(resizeOpt).write(outPath, e => e ? reject(e) : resolve());
    })
}

function traverseNode(meshToNodePath, nodes, nodePath, node) {
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

function extractMaterials(results) {
    // map nodes to meshes; WLE can't reference meshes directly when loaded via
    // WL.scene.append, so we have to map a scene path to a mesh object
    const meshToNodePath = new Map();
    const model = results.gltf;
    const nodes = model.nodes;
    for (const scene of model.scenes) {
        for (const rootNodeID of scene.nodes) {
            traverseNode(meshToNodePath, nodes, [], nodes[rootNodeID]);
        }
    }

    // remove material from mesh and map mesh to node path, replace material
    // with bogus material
    const meshMap = [];
    const meshes = model.meshes;
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

    // extract materials, textures and images, and remove samplers
    delete model.samplers;
    const textures = model.textures;
    delete model.textures;
    const materials = model.materials;
    delete model.materials;
    const images = model.images;
    delete model.images;

    // replace materials list with bogus material
    model.materials = [
        {
            "pbrMetallicRoughness": {
                "metallicFactor": 0.5,
                "roughnessFactor": 0.5,
                "baseColorFactor": [ 1, 1, 1, 1 ]
            },
            "name": "bogus-material",
            "emissiveFactor": [ 0, 0, 0 ],
            "alphaMode": "OPAQUE",
            "doubleSided": false
        }
    ];

    return [textures, images, { meshMap, materials }];
}

function makeFriendlyTextureNames(modelName, separateResources, textures, images) {
    // convert textures to friendlier format
    const newResources = {};
    const textureCount = textures.length;
    for (let i = 0; i < textureCount; i++) {
        const oldURI = images[textures[i].source].uri;
        newResources[`${modelName}.TEX${i}${path.extname(oldURI)}`] = separateResources[oldURI];
    }

    return newResources;
}

async function simplifyModel(modelBuffer, modelOutPath, lodRatio = null) {
    const inputPath = 'argument://input-model.glb';
    const interface = {
        read: (filePath) => {
            if (filePath === inputPath) {
                return modelBuffer;
            } else {
                fs.readFileSync(filePath);
            }
        },
        write: fs.writeFileSync,
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

    const log = await gltfpack.pack(args, interface);
    if (log !== '') {
        console.log(log);
    }
}

async function splitModel(inputModelPath, outputFolder, lods, embedTextures = false, defaultResizeOpt = null) {
    // make output folder
    fs.mkdirSync(outputFolder, { recursive: true });

    // parse model
    const results = await parseModel(inputModelPath);

    let modelName = path.basename(inputModelPath);
    const extLen = path.extname(modelName).length;
    if (extLen > 0) {
        modelName = modelName.substring(0, modelName.length - extLen);
    }

    // calculate effective texture resizing for each LOD
    const scaledTextures = [];
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

        lod[1] = j;
    }

    // extract materials to metadata object if needed
    let metadata;
    if (embedTextures) {
        metadata = {};
        results.separateResources = makeFriendlyTextureNames(modelName, results.separateResources, results.gltf.textures, results.gltf.images);
    } else {
        let textures, images;
        [textures, images, metadata] = extractMaterials(results, embedTextures);
        results.separateResources = makeFriendlyTextureNames(modelName, results.separateResources, textures, images);
    }

    // resize textures and convert metadata
    const textureList = separateTextures(results.separateResources, outputFolder);
    const texGroups = [];
    for (let i = 0; i < scaledTextures.length; i++) {
        const resizeOpt = scaledTextures[i];
        const texGroup = [];

        for (const inPath of textureList) {
            const ext = path.extname(inPath);
            const outPath = `${inPath.substring(0, inPath.length - ext.length)}.SCALE${i}${ext}`;
            texGroup.push(path.basename(outPath));

            if (resizeOpt === null) {
                fs.copyFileSync(inPath, outPath);
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
        fs.rmSync(inPath);
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
                const texBuffer = fs.readFileSync(path.resolve(outputFolder, texFileName));
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

            const glbResults = await gltf.gltfToGlb(texGroupModel);
            texGroupModels.push(glbResults.glb);
        }

        // delete textures
        for (const texGroup of texGroups) {
            for (const texturePath of texGroup) {
                fs.rmSync(path.resolve(outputFolder, texturePath));
            }
        }

        // simplify model of each texture group
        for (let i = 0; i < lods.length; i++) {
            const outName = `${modelName}.LOD${i}.glb`;
            const outPath = path.resolve(outputFolder, outName);
            const lod = lods[i];
            const lodRatio = lod[0];
            await simplifyModel(texGroupModels[lod[1]], outPath, lodRatio);

            metadata.lods.push({
                file: outName,
                lodRatio,
                bytes: fs.statSync(outPath).size
            });
        }
    } else {
        // simplify model
        const glbResults = await gltf.gltfToGlb(results.gltf);
        const glbModel = glbResults.glb;

        for (let i = 0; i < lods.length; i++) {
            const outName = `${modelName}.LOD${i}.glb`;
            const outPath = path.resolve(outputFolder, outName);
            const lod = lods[i];
            const lodRatio = lod[0];
            await simplifyModel(glbModel, outPath, lodRatio);

            metadata.lods.push({
                file: outName,
                lodRatio,
                textureGroup: lod[1],
                bytes: fs.statSync(outPath).size
            });
        }
    }

    // write metadata
    fs.writeFileSync(path.resolve(outputFolder, `${modelName}.metadata.json`), JSON.stringify(metadata));
}

module.exports = splitModel;

if (typeof require !== 'undefined' && require.main === module) {
    function parseResizeArg(arg) {
        if (arg.endsWith('%')) {
            const percent = Number(arg.substring(0, arg.length - 1));
            if (isNaN(percent) || percent <= 0) {
                throw new Error('Invalid percentage. Must be a number > 0');
            }

            return arg;
        } else {
            const sideLength = Number(arg);
            if (isNaN(sideLength) || sideLength <= 0) {
                throw new Error('Invalid side length. Must be a number > 0');
            }

            return `${sideLength}x${sideLength}!`;
        }
    }

    function printHelp(execPath) {
        const execName = path.basename(execPath);
        console.log(`
Usage:
${execName} <input file> <output folder> [--embed-textures] [--texture-size <percentage or target side length>] <lod 1 simplification ratio>[:<texture percentage or target side length>] <lod 2 simplification ratio>[:<texture percentage or target side length>] ...

Example usage:
- Split a model named "model.glb" into the folder "output" with 6 LOD levels (100%, 90%, 75%, 50%, 25%, and 12.5% mesh kept) and a texture size of 25%
${execName} model.glb output 1 0.9 0.75 0.5 0.25 0.125 --texture-size 25%
- Split a model named "model.glb" into the folder "output" with 4 LOD levels (100%, 75%, 50%, and 25% mesh kept) and a texture size of 100%, 50%, 25% and 12.5% respectively
${execName} model.glb output 1 0.75:50% 0.5:25% 0.25:12.5%

Options:
- <input file>: The model file to split into LODs
- <output folder>: The folder to put the split model into
- --embed-textures: Force each LOD model to have embedded textures instead of external textures
- --texture-size <percentage or target side length>: The texture size to use for each generated LOD if it's not specified in the LOD arguments
- <lod simplification ratio>[:<texture percentage or target side length>]: Adds an LOD to be generated. The simplification ratio determines how much to simplify the model; 1 is no simplification, 0.5 is 50% simplification. The texture option is equivalent to "--texture-size" but only applies to this LOD`
        );
    }

    // running from CLI. parse arguments
    let inputPath = null;
    let outputFolder = null;
    let resizeOpts = null;
    let embedTextures = false;
    const lods = [];

    try {
        const cliArgs = process.argv.slice(2);
        let expectResizeOpt = false;

        for (const arg of cliArgs) {
            if (inputPath === null) {
                inputPath = arg;
            } else if (outputFolder === null) {
                outputFolder = arg;
            } else if (expectResizeOpt) {
                expectResizeOpt = false;
                resizeOpts = parseResizeArg(arg);
            } else if (arg === '--texture-size') {
                if (resizeOpts !== null) {
                    throw new Error('--texture-size can only be specified once');
                }

                expectResizeOpt = true;
            } else if (arg === '--embed-textures') {
                embedTextures = true;
            } else {
                const parts = arg.split(':');
                if (parts.length > 2) {
                    throw new Error('LOD arguments can have at most 2 parts');
                }

                let lodRatio = 1;
                if (parts[0] !== '') {
                    lodRatio = Number(parts[0]);
                    if (isNaN(lodRatio) || lodRatio <= 0 || lodRatio > 1) {
                        throw new Error('Invalid LOD simplification ratio. Must be a number > 0 and <= 1');
                    }
                }

                let resizeOpt = null;
                if (parts[1] !== '' && parts[1] !== undefined) {
                    resizeOpt = parseResizeArg(parts[1]);
                }

                lods.push([lodRatio, resizeOpt]);
            }
        }

        if (expectResizeOpt) {
            throw new Error('Expected texture size');
        } else if (inputPath === null) {
            throw new Error('Input path not specified');
        } else if (outputFolder === null) {
            throw new Error('Output folder not specified');
        }
    } catch (e) {
        console.error(e);
        printHelp(process.argv[1]);
        process.exit(1);
    }

    try {
        splitModel(inputPath, outputFolder, lods, embedTextures, resizeOpts);
    } catch(e) {
        console.error('Error occurred while splitting model:', e);
        process.exit(2);
    }
}