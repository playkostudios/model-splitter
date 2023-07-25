import { Component, Type } from '@wonderlandengine/api';
import { LODModelLoader, ModelSplitterBasisLoader } from '../../lib/runtime-lib.esm.js';

import type { Material } from '@wonderlandengine/api';

export class ModelLoader extends Component {
    modelLoader: LODModelLoader;
    cdnRoot!: string;
    metadataURLFilename!: string;
    lod!: number;
    avoidPBR!: boolean;
    partName!: string;
    pbrTemplateMaterial!: Material | null;
    phongTemplateMaterial!: Material | null;
    pbrOpaqueTemplateMaterial!: Material | null;
    phongOpaqueTemplateMaterial!: Material | null;

    static override TypeName = 'model-loader';
    static override Properties = {
        cdnRoot: {type: Type.String},
        metadataURLFilename: {type: Type.String},
        lod: {type: Type.Int, default: 0},
        avoidPBR: {type: Type.Bool, default: false},
        partName: {type: Type.String},
        pbrTemplateMaterial: {type: Type.Material},
        phongTemplateMaterial: {type: Type.Material},
        pbrOpaqueTemplateMaterial: {type: Type.Material},
        phongOpaqueTemplateMaterial: {type: Type.Material}
    }

    override init() {
        const basisLoader = new ModelSplitterBasisLoader('basis-transcoder-worker.js');
        this.modelLoader = new LODModelLoader(this.engine, this.cdnRoot, basisLoader);
    }

    override start() {
        if (this.partName === '') {
            this.modelLoader.loadFromURL(this.metadataURLFilename, this.lod, this.avoidPBR, this.object, this.phongOpaqueTemplateMaterial, this.phongTemplateMaterial, this.pbrOpaqueTemplateMaterial, this.pbrTemplateMaterial);
        } else {
            this.modelLoader.loadPartFromURL(this.metadataURLFilename, this.partName, this.lod, this.avoidPBR, this.object, this.phongOpaqueTemplateMaterial, this.phongTemplateMaterial, this.pbrOpaqueTemplateMaterial, this.pbrTemplateMaterial);
        }
    }
}
