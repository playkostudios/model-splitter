import type { ILogger } from '@gltf-transform/core';

export type ObjectLoggerMessageType = 'debug' | 'info' | 'warn' | 'error';

/** A message in a {@link ObjectLogger}. */
export interface ObjectLoggerMessage {
    type: ObjectLoggerMessageType,
    data: string,
    time: number,
}

/** The object logger; logs to a JS object. */
export class ObjectLogger implements ILogger {
    constructor(private messageCallback: (message: ObjectLoggerMessage) => void) {}

    debug(str: string) {
        console.debug(str);
        this.messageCallback({ type: 'debug', data: str, time: Date.now() });
    }

    info(str: string) {
        console.log(str);
        this.messageCallback({ type: 'info', data: str, time: Date.now() });
    }

    warn(str: string) {
        console.warn(str);
        this.messageCallback({ type: 'warn', data: str, time: Date.now() });
    }

    error(str: string) {
        console.error(str);
        this.messageCallback({ type: 'error', data: str, time: Date.now() });
    }
}