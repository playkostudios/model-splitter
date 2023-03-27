import { Component, Type } from '@wonderlandengine/api';
import { LODModelLoader, ModelSplitterBasisLoader } from '../../lib/runtime-lib.esm';

export class ModelLoader extends Component {
    static TypeName = 'model-loader';
    static Properties = {
        cdnRoot: {type: Type.String},
        metadataURLFilename: {type: Type.String},
        lod: {type: Type.Int, default: 0},
        avoidPBR: {type: Type.Bool, default: false},
        pbrTemplateMaterial: {type: Type.Material},
        phongTemplateMaterial: {type: Type.Material},
        pbrOpaqueTemplateMaterial: {type: Type.Material},
        phongOpaqueTemplateMaterial: {type: Type.Material}
    }

    init() {
        const basisLoader = new ModelSplitterBasisLoader('basis_loader.js');
        this.modelLoader = new LODModelLoader(this.engine, this.cdnRoot, basisLoader);
    }

    start() {
        this.modelLoader.loadFromURL(this.metadataURLFilename, this.lod, this.avoidPBR, this.object, this.phongOpaqueTemplateMaterial, this.phongTemplateMaterial, this.pbrOpaqueTemplateMaterial, this.pbrTemplateMaterial);
    }
}
