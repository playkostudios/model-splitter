import type { LODConfigList, SplitModelOptions } from './lib';

export type BridgedSplitModel = (inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions) => Promise<void>;