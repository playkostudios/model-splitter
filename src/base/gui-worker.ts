import { readFileSync } from 'node:fs';
import { ObjectLogger } from './ObjectLogger';
import { InvalidInputError, CollisionError } from './ModelSplitterError';
import { splitModel as _splitModel } from './lib';
const gltfpack = require('gltfpack');

import type { ObjectLoggerMessage } from './ObjectLogger';
import type { LODConfigList, SplitModelOptions } from './external-types';
import type { WorkerMessage, WorkerMessageDone, WorkerMessageLog } from './worker-types';

// wrap splitModel and logger together
let gltfpackInitialized = false;
async function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions, messageCallback: (message: ObjectLoggerMessage) => void): Promise<void> {
    const logger = new ObjectLogger(messageCallback);

    if (!gltfpackInitialized) {
        // XXX gltfpack is not auto-initialized because nw.js contexts are weird
        logger.debug('gltfpack not initialized yet. Initializing...');
        gltfpack.init(readFileSync(__dirname + '/library.wasm'));
        gltfpackInitialized = true;
        logger.debug('gltfpack initialized');
    }

    let error: unknown, hasError = false;

    try {
        await _splitModel(inputModelPath, outputFolder, lods, {
            ...options,
            logger
        });
    } catch(err) {
        error = err;
        hasError = true;
    }

    if (hasError) {
        throw error;
    }
}

onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;

    const source = event.source;
    if (!source) {
        console.error('Unexpected null source');
        return;
    }

    if (message.msgType === 'request') {
        try {
            await splitModel(message.inputModelPath, message.outputFolder, message.lods, message.options, (msg) => {
                source.postMessage(<WorkerMessageLog>{ msgType: 'log', ...msg });
            });
        } catch (err) {
            let error: string;
            let errorType = 'other';

            if (typeof err === 'object' && err !== null) {
                if (err instanceof InvalidInputError) {
                    errorType = 'invalid-input';
                } else if (err instanceof CollisionError) {
                    errorType = 'collision';
                }

                if ((err as { message?: unknown }).message) {
                    error = `${(err as { message: unknown }).message}`;
                } else {
                    error = `${err}`;
                }
            } else {
                error = `${err}`;
            }

            source.postMessage(<WorkerMessageDone>{
                msgType: 'done', job: message.job, errorType, error
            });
            return;
        }

        source.postMessage(<WorkerMessageDone>{
            msgType: 'done', job: message.job, errorType: null
        });
    } else {
        console.error(`Unknown message type ${message.msgType}`);
    }
};