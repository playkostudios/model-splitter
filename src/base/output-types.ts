import type { vec3, mat4, vec4 } from '@gltf-transform/core';

export type ConvertedMaterialTextureName = 'emissiveTexture' | 'normalTexture' | 'albedoTexture' | 'roughnessMetallicTexture';
export type ConvertedMaterialUniformName = ConvertedMaterialTextureName | 'albedoFactor' | 'emissiveFactor' | 'alphaMaskThreshold' | 'metallicFactor' | 'roughnessFactor';

export interface ConvertedMaterial {
    pbr: boolean;
    opaque: boolean;
    normalTexture?: string,
    albedoTexture?: string,
    emissiveTexture?: string,
    roughnessMetallicTexture?: string,
    albedoFactor?: number[],
    emissiveFactor?: number[],
    alphaMaskThreshold?: number,
    metallicFactor?: number,
    roughnessFactor?: number,
}

export type Metadata = RootOnlyMetadata | DepthSplitMetadata;

export interface RootOnlyMetadata {
    lods: Array<LOD>,
}

export interface DepthSplitMetadata {
    partLods: Record<string, PartLODs>,
}

export interface PartLODs {
    lods: Array<LOD>,
    transform: mat4,
    translation: vec3,
    rotation: vec4,
    scale: vec3,
}

export interface LOD {
    file: string,
    lodRatio: number,
    bytes: number,
}