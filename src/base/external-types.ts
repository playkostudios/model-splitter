import type { ILogger } from '@gltf-transform/core';

export type ConcreteResizeOption = [width: number, height: number, type?: '%' | '!'];
export type PackedResizeOption = ConcreteResizeOption | 'keep';
export type DefaultablePackedResizeOption = PackedResizeOption | 'default';
export type BasisUniversalMode = 'disabled' | 'uastc' | 'etc1s';

export interface LODConfig {
    meshLODRatio: number;
    embedTextures?: boolean | null;
    textureResizing?: DefaultablePackedResizeOption | null;
    optimizeSceneHierarchy?: boolean | null;
    mergeMaterials?: boolean | null;
    aggressive?: boolean | null;
    basisUniversal?: BasisUniversalMode | null;
}

export type LODConfigList = Array<LODConfig>;

export interface SplitModelOptions {
    defaultEmbedTextures?: boolean;
    defaultTextureResizing?: PackedResizeOption;
    defaultOptimizeSceneHierarchy?: boolean;
    defaultMergeMaterials?: boolean;
    defaultAggressive?: boolean;
    defaultBasisUniversal?: BasisUniversalMode;
    gltfpackPath?: string;
    force?: boolean;
    logger?: ILogger;
    splitDepth?: number;
    resetPosition?: boolean;
    resetRotation?: boolean;
    resetScale?: boolean;
}