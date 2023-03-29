import { ExtensionProperty, PropertyType } from '@gltf-transform/core';
import { EXTENSION_NAME } from './extension-name';

import type { IProperty, Nullable } from '@gltf-transform/core';

const PROP_TYPE = 'PlaykoExternalWLEMaterialReference';

export interface IPlaykoExternalWLEMaterialReference extends IProperty {
    replacedMaterial: number;
}

export class PlaykoExternalWLEMaterialReference extends ExtensionProperty<IPlaykoExternalWLEMaterialReference> {
    static override EXTENSION_NAME = EXTENSION_NAME;
    declare extensionName: typeof EXTENSION_NAME;
    declare propertyType: typeof PROP_TYPE;
    declare parentTypes: [PropertyType.PRIMITIVE];

    protected override init(): void {
        this.extensionName = EXTENSION_NAME;
        this.propertyType = PROP_TYPE;
        this.parentTypes = [PropertyType.PRIMITIVE];
    }

    protected override getDefaults(): Nullable<IPlaykoExternalWLEMaterialReference> {
        return Object.assign(super.getDefaults(), {
            replacedMaterial: -1
        });
    }

    getReplacedMaterial(): number {
        return this.get('replacedMaterial');
    }

    setReplacedMaterial(replacedMaterial: number): this {
        return this.set('replacedMaterial', replacedMaterial);
    }
}