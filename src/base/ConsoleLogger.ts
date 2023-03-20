import { gray, yellow, red } from 'colors/safe';
import { Logger } from './Logger';
import { LogLevel } from './LogLevel';

/** The console logger; logs to the `console` object. */
export class ConsoleLogger implements Logger {
    constructor(private logLevel: LogLevel = LogLevel.Log) {}

    debug(str: string) {
        if (this.logLevel >= LogLevel.Debug) {
            console.debug(gray(str));
        }
    }

    log(str: string) {
        if (this.logLevel >= LogLevel.Log) {
            console.log(str);
        }
    }

    warn(str: string) {
        if (this.logLevel >= LogLevel.Warning) {
            console.warn(yellow(str));
        }
    }

    error(error: unknown) {
        if (this.logLevel >= LogLevel.Error) {
            console.error(error);
        }
    }

    errorString(str: string) {
        if (this.logLevel >= LogLevel.Error) {
            console.error(red(str));
        }
    }
}