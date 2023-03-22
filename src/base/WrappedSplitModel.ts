import type { LODConfigList, SplitModelOptions } from './lib';

export type WrappedSplitModel = (inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions) => Promise<void>;