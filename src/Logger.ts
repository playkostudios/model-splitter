/** A logger; redirects messages to an output. */
export interface Logger {
    debug(str: string): void;
    log(str: string): void;
    warn(str: string): void;
    error(error: unknown): void;
    errorString(str: string): void;
}
