import { readFileSync } from 'node:fs';
import { ObjectLogger } from './ObjectLogger';
// expose splitModel function
import { splitModel as _splitModel } from './lib';
// expose node-notifier's notify function
const { notify } = require('node-notifier');
const gltfpack = require('gltfpack');

import type { ObjectLoggerMessage } from './ObjectLogger';
import type { LODConfigList, SplitModelOptions } from './lib';

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

module.exports = { splitModel, notify };