import { LODModelLoader } from '../../lib/runtime-lib.esm';

WL.registerComponent('model-loader', {
    cdnRoot: {type: WL.Type.String},
    metadataURLFilename: {type: WL.Type.String},
    lod: {type: WL.Type.Int, default: 0},
    avoidPBR: {type: WL.Type.Bool, default: false},
    pbrTemplateMaterial: {type: WL.Type.Material},
    phongTemplateMaterial: {type: WL.Type.Material}
}, {
    async init() {
        const modelLoader = new LODModelLoader(WL, this.cdnRoot);
        modelLoader.loadFromURL(this.metadataURLFilename, this.lod, this.avoidPBR, this.phongTemplateMaterial, this.phongTemplateMaterial, this.pbrTemplateMaterial, this.pbrTemplateMaterial);
    }
});
