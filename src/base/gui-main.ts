import { InvalidInputError, CollisionError } from './ModelSplitterError';
import { Worker } from 'node:worker_threads';
// expose node-notifier's notify function
const { notify } = require('node-notifier');

import type { ObjectLoggerMessage } from './ObjectLogger';
import type { LODConfigList, SplitModelOptions } from './lib';
import type { WorkerMessage, WorkerMessageRequest } from './worker-types';

type LoggerCallback = (message: ObjectLoggerMessage) => void;
let loggerCallback: LoggerCallback | null = null;
type ResolveFunction = CallableFunction;
type RejectFunction = (err: unknown) => void;
const jobs = new Map<number, [resolve: ResolveFunction, reject: RejectFunction]>();
let nextJobID = 0;

function log(message: ObjectLoggerMessage) {
    if (loggerCallback) {
        loggerCallback(message);
    }
}

function logErr(str: string) {
    console.error(str);
    log({ type: 'error', data: `Error in worker: ${str}`, time: Date.now() });
}

let worker: null | Worker = null;

function getWorker() {
    if (!worker) {
        worker = new Worker('./worker-bundle.js');

        worker.on('message', (message: WorkerMessage) => {
            if (message.msgType === 'log') {
                log(message);
            } else if (message.msgType === 'done') {
                const jobTuple = jobs.get(message.job);
                if (jobTuple === undefined) {
                    logErr(`Unknown job ID ${message.job}`);
                    return;
                }

                const [resolve, reject] = jobTuple;
                jobs.delete(message.job);

                if (message.errorType !== null) {
                    if (message.errorType === 'invalid-input') {
                        reject(new InvalidInputError(message.error as string));
                    } else if (message.errorType === 'collision') {
                        reject(new CollisionError(message.error as string));
                    } else {
                        reject(new Error(message.error));
                    }
                } else {
                    resolve();
                }
            } else {
                logErr(`Unknown message type ${message.msgType}`);
            }
        });

        worker.on('error', (err) => {
            logErr(`Error thrown in worker thread: ${err}`);
        });

        worker.stdout.on('data', data => log({
            type: 'info',
            data: `[worker stdout] ${data}`,
            time: Date.now(),
        }));

        worker.stderr.on('data', data => log({
            type: 'error',
            data: `[worker stderr] ${data}`,
            time: Date.now(),
        }));
    }

    return worker;
}

function setLoggerCallback(newLoggerCallback: LoggerCallback) {
    loggerCallback = newLoggerCallback;
}

// make wrapper for splitModel that calls worker instead of directly calling
// splitModel. this is needed so that the main thread isn't blocked, and so that
// dependencies that use webassembly modules with sizes greater than 4KB and
// don't use `initialize` can be loaded
function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions): Promise<void> {
    return new Promise((resolve, reject) => {
        const job = nextJobID++;
        jobs.set(job, [resolve, reject]);

        getWorker().postMessage(<WorkerMessageRequest>{
            msgType: 'request', job, inputModelPath, outputFolder, lods, options
        });
    });
}

module.exports = { splitModel, notify, setLoggerCallback };