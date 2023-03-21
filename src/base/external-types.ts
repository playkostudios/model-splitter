import type { Logger } from './Logger';

export type ConcreteResizeOption = [width: number, height: number, type?: '%' | '!'];
export type PackedResizeOption = ConcreteResizeOption | 'keep';
export type DefaultablePackedResizeOption = PackedResizeOption | 'default';

export interface LODConfig {
    meshLODRatio: number;
    embedTextures?: boolean | null;
    textureResizing?: DefaultablePackedResizeOption | null;
    optimizeSceneHierarchy?: boolean | null;
    mergeMaterials?: boolean | null;
    aggressive?: boolean | null;
}

export type LODConfigList = Array<LODConfig>;

export interface SplitModelOptions {
    defaultEmbedTextures?: boolean;
    defaultTextureResizing?: PackedResizeOption;
    defaultOptimizeSceneHierarchy?: boolean;
    defaultMergeMaterials?: boolean;
    defaultAggressive?: boolean;
    force?: boolean;
    logger?: Logger;
}