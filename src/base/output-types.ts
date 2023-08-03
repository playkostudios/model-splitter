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

export type BoundingBox = [minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number];

export interface Metadata {
    lods: Array<LOD>,
    bounds: BoundingBox,
}

export interface LOD {
    file: string,
    lodRatio: number,
    bytes: number,
}