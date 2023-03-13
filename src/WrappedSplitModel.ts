import type { LODConfigList, SplitModelOptions } from './lib';
import type { ObjectLoggerMessage } from './Logger';

export type WrappedSplitModel = (inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions, messages: Array<ObjectLoggerMessage>) => Promise<void>;