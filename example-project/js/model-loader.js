import { LODModelLoader } from '../../lib/runtime-lib.esm';

WL.registerComponent('model-loader', {
    cdnRoot: {type: WL.Type.String},
    metadataURLFilename: {type: WL.Type.String},
    lod: {type: WL.Type.Int, default: 0},
    avoidPBR: {type: WL.Type.Bool, default: false},
    pbrTemplateMaterial: {type: WL.Type.Material},
    phongTemplateMaterial: {type: WL.Type.Material}
}, {
    init() {
        this.modelLoader = new LODModelLoader(WL, this.cdnRoot);
    },
    start() {
        this.modelLoader.loadFromURL(this.metadataURLFilename, this.lod, this.avoidPBR, this.object, this.phongTemplateMaterial, this.phongTemplateMaterial, this.pbrTemplateMaterial, this.pbrTemplateMaterial);
    }
});
