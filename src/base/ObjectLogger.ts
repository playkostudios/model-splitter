import { Logger } from './Logger';

/** A string message in a {@link ObjectLogger}. */
export interface ObjectLoggerStringMessage {
    type: 'debug' | 'log' | 'warn' | 'errorString',
    data: string,
    time: number,
}

/** An error message in a {@link ObjectLogger}. */
export interface ObjectLoggerErrorMessage {
    type: 'error',
    data: unknown,
    time: number,
}

/** The type of a {@link ObjectLoggerMessage}. */
export type ObjectLoggerMessageType = 'debug' | 'log' | 'warn' | 'error' | 'errorString';

/** A message in a {@link ObjectLogger}. */
export type ObjectLoggerMessage = ObjectLoggerStringMessage | ObjectLoggerErrorMessage;

/** The object logger; logs to a JS object. */
export class ObjectLogger implements Logger {
    constructor(private messageCallback: (message: ObjectLoggerMessage) => void) {}

    debug(str: string) {
        this.messageCallback({ type: 'debug', data: str, time: Date.now() });
    }

    log(str: string) {
        this.messageCallback({ type: 'log', data: str, time: Date.now() });
    }

    warn(str: string) {
        this.messageCallback({ type: 'warn', data: str, time: Date.now() });
    }

    error(error: unknown) {
        this.messageCallback({ type: 'error', data: error, time: Date.now() });
    }

    errorString(str: string) {
        this.messageCallback({ type: 'errorString', data: str, time: Date.now() });
    }
}