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

function downscaleTexture(path, resizeOpts) {
    return new Promise((resolve, reject) => {
        gm(path).resize(...resizeOpts).write(path, e => e ? reject(e) : resolve());
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

function extractMaterials(results, modelName) {
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

    // remove material from mesh and map mesh to node path
    const meshMap = [];
    const meshes = model.meshes;
    const meshCount = meshes.length;
    for (let i = 0; i < meshCount; i++) {
        let materialID = null;
        for (const primitive of meshes[i].primitives) {
            if (primitive.material !== undefined) {
                materialID = primitive.material;
                delete primitive.material;
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
    const textureCount = textures.length;
    delete model.textures;
    const materials = model.materials;
    delete model.materials;
    const images = model.images;
    delete model.images;

    // convert textures to friendlier format
    const friendlyTextures = [];
    const newResources = {};
    for (let i = 0; i < textureCount; i++) {
        const texture = textures[i];
        const oldURI = images[texture.source].uri;
        const ext = path.extname(oldURI);
        const newURI = `${modelName}.TEX${i}${ext}`;
        friendlyTextures.push(newURI);
        newResources[newURI] = results.separateResources[oldURI];
    }

    results.separateResources = newResources;

    return { meshMap, textures: friendlyTextures, materials };
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

    const args = ['-i', inputPath, '-o', modelOutPath, '-noq', '-kn'];

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

async function splitModel(inputModelPath, outputFolder, resizeOpts = null, lods = [1]) {
    fs.mkdirSync(outputFolder, { recursive: true });
    const results = await parseModel(inputModelPath);

    let modelName = path.basename(inputModelPath);
    const extLen = path.extname(modelName).length;
    if (extLen > 0) {
        modelName = modelName.substring(0, modelName.length - extLen);
    }

    const metadata = extractMaterials(results, modelName);

    const textureList = separateTextures(results.separateResources, outputFolder);
    if (resizeOpts !== null) {
        for (const path of textureList) {
            downscaleTexture(path, resizeOpts);
        }
    }

    const glbResults = await gltf.gltfToGlb(results.gltf);
    const glbModel = glbResults.glb;
    metadata.lods = [];

    for (let i = 0; i < lods.length; i++) {
        const outName = `${modelName}.LOD${i}.glb`;
        const outPath = path.resolve(outputFolder, outName);
        const lodRatio = lods[i];
        await simplifyModel(glbModel, outPath, lodRatio);

        metadata.lods.push({
            file: outName,
            lodRatio,
            bytes: fs.statSync(outPath).size
        });
    }

    fs.writeFileSync(path.resolve(outputFolder, `${modelName}.metadata.json`), JSON.stringify(metadata));
}

module.exports = splitModel;

function printHelp(execPath) {
    const execName = path.basename(execPath);
    console.log(`
Usage:
${execName} <input file> <output folder> [--texture-size <percentage or target side length>] <lod 1 simplification ratio> <lod 2 simplification ratio> ...

Example usage:
${execName} model.glb output 0.9 0.75 0.5 0.25 0.125 --texture-size 25%

Note that there is always a LOD0 with a simplification ratio of 1 (no simplification). This behaviour can be skipped by using ${execName} as a library instead of as a CLI tool.`
    );
}

if (typeof require !== 'undefined' && require.main === module) {
    // running from CLI. parse arguments
    let inputPath = null;
    let outputFolder = null;
    let resizeOpts = null;
    const lods = [1];

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
                if (arg.endsWith('%')) {
                    const percent = Number(arg.substring(0, arg.length - 1));
                    if (isNaN(percent) || percent <= 0) {
                        throw new Error('Invalid percentage. Must be a number > 0');
                    }

                    resizeOpts = [arg];
                } else {
                    const sideLength = Number(arg);
                    if (isNaN(sideLength) || sideLength <= 0) {
                        throw new Error('Invalid side length. Must be a number > 0');
                    }

                    resizeOpts = [`${sideLength}x${sideLength}!`];
                }
            } else if (arg === '--texture-size') {
                if (resizeOpts !== null) {
                    throw new Error('--texture-size can only be specified once');
                }

                expectResizeOpt = true;
            } else {
                const lodRatio = Number(arg);
                if (isNaN(lodRatio) || lodRatio <= 0 || lodRatio > 1) {
                    throw new Error('Invalid LOD simplification ratio. Must be a number > 0 and <= 1');
                }

                lods.push(lodRatio);
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
        splitModel(inputPath, outputFolder, resizeOpts, lods);
    } catch(e) {
        console.error('Error occurred while splitting model:', e);
        process.exit(2);
    }
}