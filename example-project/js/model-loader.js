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

        const json = await reponse.json();

        // download textures
        const textures = [];
        for (const textureURL of json.textures) {
            const img = await loadImage(textureURL, 10000);
            textures.push(new WL.Texture(img));
        }

        // parse materials
        const materials = [];
        const rawMaterials = json.materials;
        console.log(json);
        for (const rawMaterial of rawMaterials) {
            const material = this.pbrTemplateMaterial.clone();

            if ('pbrMetallicRoughness' in rawMaterial) {
                material.metallicFactor = rawMaterial.pbrMetallicRoughness.metallicFactor;
                material.roughnessFactor = rawMaterial.pbrMetallicRoughness.roughnessFactor;

                if ('metallicRoughnessTexture' in rawMaterial.pbrMetallicRoughness) {
                    material.roughnessMetallicTexture = textures[rawMaterial.pbrMetallicRoughness.metallicRoughnessTexture.index];
                }

                material.albedoTexture = textures[rawMaterial.pbrMetallicRoughness.baseColorTexture.index];

                if ('baseColorFactor' in rawMaterial.pbrMetallicRoughness) {
                    material.albedoColor = rawMaterial.pbrMetallicRoughness.baseColorFactor;
                }
            }

            materials.push(material);
        }

        // load model
        const root = await WL.scene.append(json.lods[this.lod].file);

        // apply materials
        // TODO
    },
});
