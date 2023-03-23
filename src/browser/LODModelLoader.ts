import { loadImage } from './loadImage';
import { EXTENSION_NAME } from '../base/extension-name';
import { Texture } from '@wonderlandengine/api';

import type { Material, MeshComponent, Object as $Object, WonderlandEngine } from '@wonderlandengine/api';
import type { ConvertedMaterial, ConvertedMaterialTextureName, ConvertedMaterialUniformName, Metadata } from '../base/output-types';

type ExtMeshData = Record<number, Record<string, { replacedMaterials: Array<[meshIdx: number, matIdx: number]> }>>;
type ExtRootData = Record<string, { convertedMaterials: Array<ConvertedMaterial> }>;
type ExtData = { root: ExtRootData, mesh: ExtMeshData };

export class LODModelLoader {
    textures = new Map<string, Texture | null>()
    cdnRoot?: string;

    constructor(public engine: WonderlandEngine, cdnRoot?: string, public timeout = 10000) {
        this.cdnRoot = cdnRoot === '' ? undefined : cdnRoot;
        if (this.cdnRoot !== undefined && this.cdnRoot.startsWith('~')) {
            this.cdnRoot = new URL(this.cdnRoot.substring(1), window.location.href).href;
        }
    }

    async loadFromURL(metadataURL: string, lodLevel: number, avoidPBR: boolean, parent: $Object | null = null, phongOpaqueTemplateMaterial?: Material, phongTransparentTemplateMaterial?: Material, pbrOpaqueTemplateMaterial?: Material, pbrTransparentTemplateMaterial?: Material) {
        // fetch metadata
        if (metadataURL === '') {
            throw new Error('No metadata URL specified');
        }

        const url = new URL(metadataURL, this.cdnRoot);
        const reponse = await fetch(url);
        if (!reponse.ok) {
            throw new Error('Could not fetch metadata; not OK');
        }

        const metadata = await reponse.json();

        // load LOD
        return await this.load(metadata, lodLevel, avoidPBR, parent, phongOpaqueTemplateMaterial, phongTransparentTemplateMaterial, pbrOpaqueTemplateMaterial, pbrTransparentTemplateMaterial);
    }

    async load(metadata: Metadata, lodLevel: number, avoidPBR: boolean, parent: $Object | null = null, phongOpaqueTemplateMaterial?: Material, phongTransparentTemplateMaterial?: Material, pbrOpaqueTemplateMaterial?: Material, pbrTransparentTemplateMaterial?: Material) {
        // validate lod level and correct if necessary
        const lodMax = metadata.lods.length;

        if (lodLevel < 0) {
            console.warn('Negative LOD level. Corrected to 0');
            lodLevel = 0;
        } else if (lodLevel >= lodMax) {
            lodLevel = lodMax - 1;
            console.warn(`LOD level exceeds maximum (lowest detail). Corrected to ${lodLevel}`);
        }

        // load model
        const modelURL = new URL(metadata.lods[lodLevel].file, this.cdnRoot);
        // TODO stop typecasting when WLE type defs are fixed
        const sceneAppendParams = { loadGltfExtensions: true } as unknown as Record<string, string>;
        const { root, extensions } = await this.engine.scene.append(modelURL.href, sceneAppendParams) as { root: $Object, extensions: ExtData };

        // check if there are converted materials (external textures)
        let convertedMaterials: Array<ConvertedMaterial> | null = null;
        if (extensions.root) {
            const extRootData = extensions.root[EXTENSION_NAME];
            if (extRootData && Array.isArray(extRootData.convertedMaterials)) {
                convertedMaterials = extRootData.convertedMaterials;
            }
        }

        // deactivate meshes so there isn't a flash of no textures, or flash
        // with wrong parent, if needed
        const deactivateList = new Array<MeshComponent>();
        if (convertedMaterials !== null || parent !== null) {
            this.deactivateMeshes(root, deactivateList);
        }

        // apply materials
        if (convertedMaterials !== null) {
            const materials = await this.loadMaterials(convertedMaterials, avoidPBR, phongOpaqueTemplateMaterial, phongTransparentTemplateMaterial, pbrOpaqueTemplateMaterial, pbrTransparentTemplateMaterial);
            this.replaceMaterials(root, extensions.mesh, materials);
        }

        // reparent
        if (parent !== null) {
            root.parent = parent;
        }

        // reactivate meshes
        for (const mesh of deactivateList) {
            mesh.active = true;
        }

        return root;
    }

    private deactivateMeshes(root: $Object, deactivateList: Array<MeshComponent>): void {
        const stack = [root];
        while (stack.length > 0) {
            const next = stack.pop() as $Object;
            const meshes = next.getComponents('mesh') as Array<MeshComponent>;

            for (const mesh of meshes) {
                mesh.active = false;
                deactivateList.push(mesh);
            }

            stack.push(...next.children);
        }
    }

    private async loadTexture(texSrc: string): Promise<Texture | null> {
        // download texture if not already loaded
        let texture = this.textures.get(texSrc) ?? null;
        if (texture) {
            return texture;
        }

        try {
            texture = new Texture(this.engine, await loadImage(texSrc, this.cdnRoot, this.timeout));
        } catch (err) {
            console.error(err);
            console.warn(`Failed to download or initialize texture "${texSrc}"`);
        }

        if (texture !== null && !texture.valid) {
            console.warn(`Invalid texture "${texSrc}"; maybe the atlas is full?`);
            texture = null;
        }

        this.textures.set(texSrc, texture);
        return texture;
    }

    private transferUniform(srcMat: ConvertedMaterial, dstMat: Material, uniformName: ConvertedMaterialUniformName): boolean {
        const origValue = srcMat[uniformName] ?? null;
        if (origValue !== null) {
            // XXX WLE materials dont have proper uniform type definitions, so
            //     we have to cast
            (dstMat as unknown as Record<string, unknown>)[uniformName] = origValue;
            return true;
        } else {
            return false;
        }
    }

    private async transferTextureUniform(srcMat: ConvertedMaterial, dstMat: Material, uniformName: ConvertedMaterialTextureName): Promise<boolean>;
    private async transferTextureUniform(srcMat: ConvertedMaterial, dstMat: Material, uniformName: string, srcUniformName: ConvertedMaterialTextureName): Promise<boolean>;
    private async transferTextureUniform(srcMat: ConvertedMaterial, dstMat: Material, uniformName: ConvertedMaterialTextureName | string, srcUniformName?: ConvertedMaterialTextureName): Promise<boolean> {
        const texSrc = srcMat[(srcUniformName ?? uniformName) as ConvertedMaterialTextureName] ?? null;
        if (texSrc !== null) {
            // XXX WLE materials dont have proper uniform type definitions, so
            //     we have to cast
            const texture = await this.loadTexture(texSrc);
            if (texture) {
                (dstMat as unknown as Record<string, unknown>)[uniformName] = texture;
            }

            return true;
        } else {
            return false;
        }
    }

    private async loadMaterials(convertedMaterials: Array<ConvertedMaterial>, avoidPBR: boolean, phongOpaque?: Material, phongTransparent?: Material, pbrOpaque?: Material, pbrTransparent?: Material): Promise<Array<Material | null>> {
        const materials = new Array<Material | null>();

        for (const rawMat of convertedMaterials) {
            // get template material and clone it
            const pbr = avoidPBR ? false : rawMat.pbr;
            const opaque = rawMat.opaque;

            let template: Material | undefined;
            if (pbr) {
                if (opaque) {
                    template = pbrOpaque;
                } else {
                    template = pbrTransparent;
                }
            } else {
                if (opaque) {
                    template = phongOpaque;
                } else {
                    template = phongTransparent;
                }
            }

            if (!template) {
                throw new Error(`Template material not available (${pbr ? 'PBR' : 'Phong'} ${opaque ? 'Opaque' : 'Transparent'})`);
            }

            const mat = template.clone();
            if (mat === null) {
                console.warn('Failed to clone material, skipping');
                materials.push(null);
                continue;
            }

            if (pbr) {
                // pbr
                if (await this.transferTextureUniform(rawMat, mat, 'albedoTexture')) {
                    this.transferUniform(rawMat, mat, 'albedoFactor');
                }

                if (await this.transferTextureUniform(rawMat, mat, 'roughnessMetallicTexture')) {
                    this.transferUniform(rawMat, mat, 'metallicFactor');
                    this.transferUniform(rawMat, mat, 'roughnessFactor');
                }
            } else {
                // phong
                // XXX diffuse texture requires special case, as it's always
                // present as the albedo for pbr materials
                await this.transferTextureUniform(rawMat, mat, 'diffuseTexture', 'albedoTexture');
            }

            // common
            if (!opaque) {
                await this.transferTextureUniform(rawMat, mat, 'normalTexture');

                if (await this.transferTextureUniform(rawMat, mat, 'emissiveTexture')) {
                    this.transferUniform(rawMat, mat, 'emissiveFactor');
                }

                this.transferUniform(rawMat, mat, 'alphaMaskThreshold');
            }

            materials.push(mat);
        }

        return materials;
    }

    private replaceMaterials(root: $Object, extMeshData: ExtMeshData, materials: Array<Material | null>) {
        if (materials.length === 0) {
            return;
        }

        const stack = [root];
        while (stack.length > 0) {
            const next = stack.pop() as $Object;
            const objExtList = extMeshData[next.objectId];

            if (objExtList && objExtList[EXTENSION_NAME]) {
                const objExt = objExtList[EXTENSION_NAME];
                const replacedMaterials = objExt.replacedMaterials;
                const meshComps = next.getComponents('mesh') as Array<MeshComponent>;

                for (const [meshIdx, matIdx] of replacedMaterials) {
                    const mat = materials[matIdx];
                    if (mat) {
                        meshComps[meshIdx].material = mat;
                    }
                }
            }

            stack.push(...next.children);
        }
    }
}