import type { WorkerMessage, WorkerMessageDone, WorkerMessageInit, WorkerMessageLog } from './worker-types';
import { InvalidInputError, CollisionError } from '../base/ModelSplitterError';
import { ObjectLogger } from '../base/ObjectLogger';
import { splitModel } from '../base/lib';

// HACK fix error due to tsconfig. ideally we'd have a separate project folder
// which would fix this issue
if (typeof globalThis.exports === 'undefined') {
    globalThis.exports = {};
}

globalThis.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;

    if (message.msgType === 'request') {
        try {
            const logger = new ObjectLogger((msg) => {
                postMessage(<WorkerMessageLog>{ msgType: 'log', ...msg });
            });

            await splitModel(message.inputModelPath, message.outputFolder, message.lods, { ...message.options, logger });
        } catch (err: unknown) {
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

            postMessage(<WorkerMessageDone>{
                msgType: 'done', job: message.job, errorType, error
            });
            return;
        }

        postMessage(<WorkerMessageDone>{
            msgType: 'done', job: message.job, errorType: null
        });
    } else {
        console.error(`Unknown message type ${message.msgType}`);
    }
};

postMessage(<WorkerMessageInit>{ msgType: 'init' });