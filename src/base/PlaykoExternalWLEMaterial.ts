import { Extension } from '@gltf-transform/core';
import { EXTENSION_NAME } from './extension-name';

import type { ReaderContext, WriterContext } from '@gltf-transform/core';
import type { ConvertedMaterial } from './output-types';
import { PlaykoExternalWLEMaterialReference } from './PlaykoExternalWLEMaterialReference';

export class PlaykoExternalWLEMaterial extends Extension {
    static override EXTENSION_NAME = EXTENSION_NAME;
    override readonly extensionName = EXTENSION_NAME;

    convertedMaterials = new Array<ConvertedMaterial>();

    override read(_context: ReaderContext): this {
        throw new Error(`Cannot use models which already use the ${EXTENSION_NAME} extension`);
    }

    override write(context: WriterContext): this {
        if (this.convertedMaterials.length > 0) {
            const json = context.jsonDoc.json;
            if (!json.meshes) {
                throw new Error('Unexpected missing mesh list');
            }

            // write root extension data
            const rootExtList = json.extensions ?? {};
            rootExtList[EXTENSION_NAME] = {
                convertedMaterials: this.convertedMaterials
            };

            json.extensions = rootExtList;

            // write mesh extension data
            const root = this.document.getRoot();
            for (const mesh of root.listMeshes()) {
                const mIdx = context.meshIndexMap.get(mesh);
                if (mIdx === undefined) {
                    continue;
                }

                const replacedMaterials = new Array<[ pIdx: number, cmID: number]>();
                const primitives = mesh.listPrimitives();
                const primCount = primitives.length;

                for (let p = 0; p < primCount; p++) {
                    const primitive = primitives[p];
                    const pExtData = primitive.getExtension(EXTENSION_NAME) as PlaykoExternalWLEMaterialReference | null;
                    if (pExtData === null) {
                        continue;
                    }

                    replacedMaterials.push([p, pExtData.getReplacedMaterial()]);
                }

                const jsonMesh = json.meshes[mIdx];
                if (replacedMaterials.length > 0) {
                    const meshExtList = jsonMesh.extensions ?? {};
                    meshExtList[EXTENSION_NAME] = { replacedMaterials };
                    jsonMesh.extensions = meshExtList;
                }
            }
        } else {
            // remove from list of used extensions if converted materials map is
            // empty
            const json = context.jsonDoc.json;
            if (json.extensionsUsed) {
                json.extensionsUsed.filter(name => name !== EXTENSION_NAME);
            }
            if (json.extensionsRequired) {
                json.extensionsRequired.filter(name => name !== EXTENSION_NAME);
            }
        }

        return this;
    }

    hasConvertedMaterials(): boolean {
        return this.convertedMaterials.length > 0;
    }

    addConvertedMaterial(convertedMaterial: ConvertedMaterial): number {
        const idx = this.convertedMaterials.length;
        this.convertedMaterials.push(convertedMaterial);
        return idx;
    }
}