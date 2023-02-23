function loadImage(/** @type {string} */ url, /** @type {number} */ timeoutMS) {
    return new Promise((resolve, reject) => {
        const img = document.createElement('img');
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
    metadataURL: {type: WL.Type.String},
    lod: {type: WL.Type.Int, default: 0},
    pbrTemplateMaterial: {type: WL.Type.Material}
}, {
    init: async function() {
        // fetch metadata
        if (this.metadataURL === '') {
            throw new Error('No metadata URL specified');
        }

        const reponse = await fetch(this.metadataURL);
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

        // download textures
        const textures = [];
        for (const textureURL of meta.textures) {
            let texture = null;

            try {
                texture = new WL.Texture(await loadImage(textureURL, 10000));
            } catch (err) {
                console.warn(`Failed to download or initialize texture "${textureURL}"`);
            }

            textures.push(texture);
        }

        // parse materials
        const materials = [];
        const rawMaterials = meta.materials;
        for (const rawMaterial of rawMaterials) {
            let material = null;

            if ('pbrMetallicRoughness' in rawMaterial) {
                const gltfMat = rawMaterial.pbrMetallicRoughness;
                material = this.pbrTemplateMaterial.clone();

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
                    } else {
                        material.roughnessMetallicTexture = texture;
                    }
                }

                if ('baseColorTexture' in gltfMat && 'index' in gltfMat.baseColorTexture) {
                    const textureIdx = gltfMat.baseColorTexture.index;
                    const texture = textures[textureIdx];
                    if (texture === undefined) {
                        console.warn(`Ignored "baseColorTexture"; missing texture index "${textureIdx}"`);
                    } else {
                        material.albedoTexture = texture;
                    }
                }

                if ('baseColorFactor' in gltfMat) {
                    if (Array.isArray(gltfMat.baseColorFactor) && gltfMat.baseColorFactor.length === 4) {
                        material.albedoColor = gltfMat.baseColorFactor;
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

        // load model
        const root = await WL.scene.append(meta.lods[lodLevel].file);

        // apply materials
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
        }
    },
});
