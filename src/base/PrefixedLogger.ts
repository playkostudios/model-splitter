import type { ILogger } from '@gltf-transform/core';

export class PrefixedLogger implements ILogger {
    constructor(private readonly prefix: string, private readonly baseLogger: ILogger) {}

    debug(str: string): void {
        this.baseLogger.debug(`${this.prefix}${str}`);
    }

    info(str: string): void {
        this.baseLogger.info(`${this.prefix}${str}`);
    }

    warn(str: string): void {
        this.baseLogger.warn(`${this.prefix}${str}`);
    }

    error(str: string): void {
        this.baseLogger.error(`${this.prefix}${str}`);
    }
}
