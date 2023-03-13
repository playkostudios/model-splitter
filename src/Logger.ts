/** A callback for a logger */
export type LoggerCallback = (str: string) => void;

/** A logger; redirects messages to an output. */
export interface Logger {
    debug(str: string): void;
    log(str: string): void;
    warn(str: string): void;
    error(error: unknown): void;
    errorString(str: string): void;
}

/** The console logger; logs to the `console` object. */
export class ConsoleLogger implements Logger {
    debug(str: string) {
        console.debug(str);
    }

    log(str: string) {
        console.log(str);
    }

    warn(str: string) {
        console.warn(str);
    }

    error(error: unknown) {
        console.error(error);
    }

    errorString(str: string) {
        console.error(str);
    }
}

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
    messages = new Array<ObjectLoggerMessage>();

    debug(str: string) {
        this.messages.push({ type: 'debug', data: str, time: Date.now() });
    }

    log(str: string) {
        this.messages.push({ type: 'log', data: str, time: Date.now() });
    }

    warn(str: string) {
        this.messages.push({ type: 'warn', data: str, time: Date.now() });
    }

    error(error: unknown) {
        this.messages.push({ type: 'error', data: error, time: Date.now() });
    }

    errorString(str: string) {
        this.messages.push({ type: 'errorString', data: str, time: Date.now() });
    }
}