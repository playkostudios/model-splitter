import type { LODConfigList, SplitModelOptions } from '../base/external-types';
import type { ObjectLoggerMessage, ObjectLoggerMessageType } from '../base/ObjectLogger';

export interface WorkerMessageLog extends ObjectLoggerMessage {
    msgType: 'log',
    type: ObjectLoggerMessageType,
    data: string,
    time: number,
}

export interface WorkerMessageDone {
    msgType: 'done',
    job: number,
    errorType: null | 'invalid-input' | 'collision' | 'other',
    error?: string,
}

export interface WorkerMessageRequest {
    msgType: 'request',
    job: number,
    inputModelPath: string,
    outputFolder: string,
    lods: LODConfigList,
    options: SplitModelOptions,
}

export interface WorkerMessageInit {
    msgType: 'init',
}

export type WorkerMessage = WorkerMessageLog | WorkerMessageDone | WorkerMessageRequest | WorkerMessageInit;