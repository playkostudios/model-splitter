import type { ResizeOption } from 'gm';
import type { Logger } from './Logger';

export type ConcreteResizeOption = [width: number, height: number, type?: ResizeOption];
export type PackedResizeOption = ConcreteResizeOption | 'keep';
export type DefaultablePackedResizeOption = PackedResizeOption | 'default';

export interface LODConfig {
    meshLODRatio: number;
    embedTextures?: boolean | null;
    textureResizing?: DefaultablePackedResizeOption | null;
    optimizeSceneHierarchy?: boolean | null;
    mergeMaterials?: boolean | null;
    quantizeDequantizeMesh?: boolean | null;
}

export type LODConfigList = Array<LODConfig>;

export interface SplitModelOptions {
    defaultEmbedTextures?: boolean;
    defaultTextureResizing?: PackedResizeOption;
    defaultOptimizeSceneHierarchy?: boolean;
    defaultMergeMaterials?: boolean;
    defaultQuantizeDequantizeMesh?: boolean;
    force?: boolean;
    logger?: Logger;
}