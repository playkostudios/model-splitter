import { gray, yellow, red } from 'colors/safe';
import { Logger } from './Logger';

/** The console logger; logs to the `console` object. */
export class ConsoleLogger implements Logger {
    debug(str: string) {
        console.debug(gray(str));
    }

    log(str: string) {
        console.log(str);
    }

    warn(str: string) {
        console.warn(yellow(str));
    }

    error(error: unknown) {
        console.error(error);
    }

    errorString(str: string) {
        console.error(red(str));
    }
}