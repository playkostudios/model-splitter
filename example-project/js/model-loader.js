function loadImage(/** @type {string} */ urlFilename, /** @type {string | undefined} */ urlRoot, /** @type {number} */ timeoutMS) {
    return new Promise((resolve, reject) => {
        const img = document.createElement('img');
        const url = new URL(urlFilename, urlRoot);
        img.src = url;

        function settle(callback) {
            if (timeout !== null) {
                clearTimeout(timeout);
                timeout = null;
                callback();
            }
        }

        const timeoutReject = () => reject(new Error('Timed out'));
        let timeout = setTimeout(() => settle(timeoutReject), timeoutMS);
        img.addEventListener('load', () => settle(() => resolve(img)));
        img.addEventListener('error', (ev) => {
            settle(() => reject(ev.error ?? new Error('Error occurred while loading image')));
        });
    });
}

WL.registerComponent('model-loader', {
    cdnRoot: {type: WL.Type.String},
    metadataURLFilename: {type: WL.Type.String},
    lod: {type: WL.Type.Int, default: 0},
    avoidPBR: {type: WL.Type.Bool, default: false},
    pbrTemplateMaterial: {type: WL.Type.Material},
    phongTemplateMaterial: {type: WL.Type.Material}
}, {
    init: async function() {
        // fetch metadata
        if (this.metadataURLFilename === '') {
            throw new Error('No metadata URL specified');
        }

        let cdnRoot = this.cdnRoot === '' ? undefined : this.cdnRoot;
        if (cdnRoot.startsWith('~')) {
            cdnRoot = new URL(cdnRoot.substring(1), window.location).href;
        }

        const url = new URL(this.metadataURLFilename, cdnRoot);
        const reponse = await fetch(url);
        if (!reponse.ok) {
            throw new Error('Could not fetch metadata; not OK');
        }

        const meta = await reponse.json();

        // validate lod level and correct if necessary
        let lodLevel = this.lod;
        const lodMax = meta.lods.length;

        if (lodLevel < 0) {
            console.warn('Negative LOD level. Corrected to 0');
            lodLevel = 0;
        } else if (lodLevel >= lodMax) {
            lodLevel = lodMax - 1;
            console.warn(`LOD level exceeds maximum (lowest detail). Corrected to ${lodLevel}`);
        }

        const lodConfig = meta.lods[lodLevel];

        // download textures. this will not be necessary if the textures are
        // embedded
        const textures = [];
        if (lodConfig.textureGroup !== undefined) {
            for (const textureURL of meta.textureGroups[lodConfig.textureGroup]) {
                let texture = null;

                try {
                    texture = new WL.Texture(await loadImage(textureURL, cdnRoot, 10000));
                } catch (err) {
                    console.error(err);
                    console.warn(`Failed to download or initialize texture "${textureURL}"`);
                }

                if (texture !== null && !texture.valid) {
                    console.warn(`Invalid texture "${textureURL}"; maybe the atlas is full?`);
                    texture = null;
                }

                textures.push(texture);
            }
        }

        // parse materials
        const materials = this.loadMaterials(textures, meta.materials);

        // load model
        const modelURL = new URL(lodConfig.file, cdnRoot);
        const root = await WL.scene.append(modelURL.href);

        // apply materials
        if (materials === null) {
            this.replaceMaterials(root);
            return;
        }

        for (const [pathComponents, materialIdx] of meta.meshMap) {
            const material = materials[materialIdx];
            if (material === undefined) {
                console.warn(`Missing material index ${materialIdx}`);
                continue;
            } else if (material === null) {
                console.warn(`Ignored mesh setup for material index ${materialIdx}; material initialization failed`);
                continue;
            }

            let focus = root;
            for (const component of pathComponents) {
                const oldFocus = focus;
                for (const child of focus.children) {
                    if (child.name === component) {
                        focus = child;
                        break;
                    }
                }

                if (focus === oldFocus) {
                    focus = null;
                    break;
                }
            }

            if (focus === null) {
                console.warn(`Could not find node in path "${pathComponents.join('/')}"`);
                continue;
            }

            let meshComponent = focus.getComponent('mesh');
            if (meshComponent === null) {
                // gltfpack will move the mesh component to a new unnamed child
                // node
                const origFocus = focus;
                const children = focus.children;
                if (children.length === 1) {
                    focus = children[0];
                    if (focus.children.length === 0) {
                        meshComponent = focus.getComponent('mesh');
                    }
                } else if (children.length > 0) {
                    for (const child of children) {
                        if (child.name.startsWith('object_') && child.children.length === 0) {
                            meshComponent = focus.getComponent('mesh');
                            if (meshComponent !== null) {
                                break;
                            }
                        }
                    }
                } else {
                    console.warn(`Could not get mesh component for descendant "${origFocus.name}", and descendant has no unnamed child`);
                    continue;
                }

                if (meshComponent === null) {
                    console.warn(`Could not get mesh component for descendant "${origFocus.name}", and descendant's unnamed child has no mesh component either`);
                    continue;
                }
            }

            meshComponent.material = material;

            // const mesh = meshComponent.mesh;
            // meshComponent.active = false;
            // meshComponent.destroy();
            // setTimeout(() => {
            //     focus.addComponent('mesh', { mesh, material })
            // }, 1000);
        }
    },
    loadMaterials(textures, rawMaterials) {
        if (rawMaterials === undefined) {
            return null;
        }

        const materials = [];

        for (const rawMaterial of rawMaterials) {
            let material = null;

            if ('pbrMetallicRoughness' in rawMaterial) {
                const gltfMat = rawMaterial.pbrMetallicRoughness;

                if (this.avoidPBR) {
                    material = this.phongTemplateMaterial.clone();
                } else {
                    material = this.pbrTemplateMaterial.clone();
                }

                if ('normalTexture' in rawMaterial && 'index' in rawMaterial.normalTexture) {
                    const textureIdx = rawMaterial.normalTexture.index;
                    const texture = textures[textureIdx];
                    if (texture === undefined) {
                        console.warn(`Ignored "normalTexture"; missing texture index "${textureIdx}"`);
                    } else if (texture === null) {
                        console.warn(`Ignored "normalTexture"; texture index "${textureIdx}" was not loaded`);
                    } else {
                        material.normalTexture = texture;
                    }
                }

                if (!this.avoidPBR) {
                    if ('metallicFactor' in gltfMat) {
                        material.metallicFactor = gltfMat.metallicFactor;
                    }

                    if ('roughnessFactor' in gltfMat) {
                        material.roughnessFactor = gltfMat.roughnessFactor;
                    }

                    if ('metallicRoughnessTexture' in gltfMat && 'index' in gltfMat.metallicRoughnessTexture) {
                        const textureIdx = gltfMat.metallicRoughnessTexture.index;
                        const texture = textures[textureIdx];
                        if (texture === undefined) {
                            console.warn(`Ignored "metallicRoughnessTexture"; missing texture index "${textureIdx}"`);
                        } else if (texture === null) {
                            console.warn(`Ignored "metallicRoughnessTexture"; texture index "${textureIdx}" was not loaded`);
                        } else {
                            material.roughnessMetallicTexture = texture;
                        }
                    }
                }

                if ('baseColorTexture' in gltfMat && 'index' in gltfMat.baseColorTexture) {
                    const textureIdx = gltfMat.baseColorTexture.index;
                    const texture = textures[textureIdx];
                    if (texture === undefined) {
                        console.warn(`Ignored "baseColorTexture"; missing texture index "${textureIdx}"`);
                    } else if (texture === null) {
                        console.warn(`Ignored "baseColorTexture"; texture index "${textureIdx}" was not loaded`);
                    } else {
                        if (this.avoidPBR) {
                            material.diffuseTexture = texture;
                        } else {
                            material.albedoTexture = texture;
                        }
                    }
                }

                if ('baseColorFactor' in gltfMat) {
                    if (Array.isArray(gltfMat.baseColorFactor) && gltfMat.baseColorFactor.length === 4) {
                        if (this.avoidPBR) {
                            material.diffuseColor = gltfMat.baseColorFactor;
                        } else {
                            material.albedoColor = gltfMat.baseColorFactor;
                        }
                    } else {
                        console.warn('Ignored "baseColorfactory"; invalid length or not an array');
                    }
                }
            } else {
                // TODO what other materials are there in gltf? i can only find
                // physical materials
                console.warn(`Unknown material in GLTF, not added`);
            }

            materials.push(material);
        }

        return materials;
    },
    transferUniform(srcMat, dstMat, uniformName) {
        const origValue = srcMat[uniformName];
        if (origValue !== undefined) {
            dstMat[uniformName] = origValue;
        }
    },
    replaceMaterials(obj) {
        const meshComp = obj.getComponent('mesh');
        if (meshComp) {
            const srcMat = meshComp.material;
            if (srcMat) {
                if (srcMat.shader === 'Physical Opaque Textured') {
                    const dstMat = this.pbrTemplateMaterial.clone();
                    meshComp.material = dstMat;

                    this.transferUniform(srcMat, dstMat, 'albedoColor');
                    this.transferUniform(srcMat, dstMat, 'metallicFactor');
                    this.transferUniform(srcMat, dstMat, 'roughnessFactor');
                    this.transferUniform(srcMat, dstMat, 'albedoTexture');
                    this.transferUniform(srcMat, dstMat, 'roughnessMetallicTexture');
                    this.transferUniform(srcMat, dstMat, 'normalTexture');
                } else if (srcMat.shader === 'Phong Opaque Textured') {
                    const dstMat = this.phongTemplateMaterial.clone();
                    meshComp.material = dstMat;

                    this.transferUniform(srcMat, dstMat, 'ambientColor');
                    this.transferUniform(srcMat, dstMat, 'diffuseColor');
                    this.transferUniform(srcMat, dstMat, 'specularColor');
                    this.transferUniform(srcMat, dstMat, 'fogColor');
                    this.transferUniform(srcMat, dstMat, 'diffuseTexture');
                    this.transferUniform(srcMat, dstMat, 'normalTexture');
                    this.transferUniform(srcMat, dstMat, 'shininess');
                    this.transferUniform(srcMat, dstMat, 'ambientFactor');
                } else {
                    console.warn('Unknown shader ignored', srcMat.shader);
                }
            }
        }

        for (const child of obj.children) {
            this.replaceMaterials(child);
        }
    },
});
