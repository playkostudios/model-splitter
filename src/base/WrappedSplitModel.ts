import type { LODConfigList, SplitModelOptions } from './lib';
import type { ObjectLoggerMessage } from './ObjectLogger';

export type WrappedSplitModel = (inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions, messageCallback: (message: ObjectLoggerMessage) => void) => Promise<void>;