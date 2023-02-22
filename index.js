const gltf = require('gltf-pipeline');
const fs = require('node:fs');
const path = require('node:path');
const gm = require('gm');

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

function extractMaterials(model) {
    // map nodes to meshes; WLE can't reference meshes directly when loaded via
    // WL.scene.append, so we have to map a scene path to a mesh object
    const meshToNodePath = new Map();
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
    for (let i = 0; i < textureCount; i++) {
        const texture = textures[i];
        friendlyTextures.push(images[texture.source].uri);
    }

    return { meshMap, textures: friendlyTextures, materials };
}

async function splitModel(inputModelPath, outputFolder, targetTextureLength) {
    fs.mkdirSync(outputFolder, { recursive: true });
    const results = await parseModel(inputModelPath);
    const textureList = separateTextures(results.separateResources, outputFolder);

    for (const path of textureList) {
        downscaleTexture(path, targetTextureLength);
    }

    const model = results.gltf;
    const metadata = extractMaterials(model);
    let modelName = path.basename(inputModelPath);
    const extLen = path.extname(modelName).length;
    if (extLen > 0) {
        modelName = modelName.substring(0, modelName.length - extLen);
    }

    fs.writeFileSync(path.resolve(outputFolder, `${modelName}.metadata.json`), JSON.stringify(metadata));

    const glbResults = await gltf.gltfToGlb(model);
    fs.writeFileSync(path.resolve(outputFolder, `${modelName}.glb`), glbResults.glb);
}

splitModel('model.glb', 'output', ['20%']);