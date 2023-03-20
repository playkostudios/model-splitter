import { readFileSync } from 'node:fs';
import { ObjectLogger } from './ObjectLogger';
// expose splitModel function
import { splitModel as _splitModel } from './lib';
// expose node-notifier's notify function
const { notify } = require('node-notifier');

import type { ObjectLoggerMessage } from './ObjectLogger';
import type { LODConfigList, SplitModelOptions } from './lib';

// XXX gltfpack is not auto-initialized because nw.js contexts are weird
const gltfpack = require('gltfpack');
gltfpack.init(readFileSync(__dirname + '/library.wasm'));

// wrap splitModel and logger together
async function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions, messageCallback: (message: ObjectLoggerMessage) => void): Promise<void> {
    const logger = new ObjectLogger(messageCallback);

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

module.exports = { splitModel, notify };