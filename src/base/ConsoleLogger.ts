import { Verbosity } from '@gltf-transform/core';
import { gray, yellow, red } from 'colors/safe';

import type { ILogger } from '@gltf-transform/core';

/** The console logger; logs to the `console` object. */
export class ConsoleLogger implements ILogger {
    constructor(private readonly verbosity: Verbosity = Verbosity.INFO) {}

    debug(str: string) {
        if (this.verbosity <= Verbosity.DEBUG) {
            console.debug(gray(str));
        }
    }

    info(str: string) {
        if (this.verbosity <= Verbosity.INFO) {
            console.info(str);
        }
    }

    warn(str: string) {
        if (this.verbosity <= Verbosity.WARN) {
            console.warn(yellow(str));
        }
    }

    error(str: string) {
        if (this.verbosity <= Verbosity.ERROR) {
            console.error(red(str));
        }
    }
}
