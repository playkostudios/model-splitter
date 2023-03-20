import type { PackedResizeOption } from './lib';

export type ParsedLODConfig = [ gltfpackArgCombo: number, textureResizeOpt: PackedResizeOption, embedTextures: boolean ];
export type ParsedLODConfigList = Array<ParsedLODConfig>;
export type GltfpackArgCombo = [ meshLODRatio: number, optimizeSceneHierarchy: boolean, mergeMaterials: boolean, quantDequantMesh: boolean ];
export type ProcessedTextureList = Array<[ inputs: Array<[resizeOpt: PackedResizeOption, origHash: string]>, hash: string, content: Buffer, save: boolean ]>;
export type OriginalImagesList = Array<[buffer: Buffer, origHash: string]>;