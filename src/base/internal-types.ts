import type { BasisUniversalMode, PackedResizeOption } from './lib';

export type ParsedLODConfig = [ gltfpackArgCombo: number, textureResizeOpt: PackedResizeOption, embedTextures: boolean ];
export type ParsedLODConfigList = Array<ParsedLODConfig>;
export type GltfpackArgCombo = [ meshLODRatio: number, optimizeSceneHierarchy: boolean, mergeMaterials: boolean, aggressive: boolean, basisu: BasisUniversalMode, basisuTextureResizeOpt: PackedResizeOption ];
export type ProcessedTextureList = Array<[ inputs: Array<[resizeOpt: PackedResizeOption, origHash: string]>, hash: string, content: Buffer, save: boolean ]>;
export type OriginalImagesList = Array<null | [buffer: Buffer, origHash: string]>;