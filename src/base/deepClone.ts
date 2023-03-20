export function deepClone<T>(val: T): T {
    if (val === null || typeof val !== 'object') {
        return val;
    } else if (Array.isArray(val)) {
        const outVal = [] as T;

        for (const subVal of val) {
            (outVal as Array<unknown>).push(deepClone(subVal));
        }

        return outVal;
    } else {
        const outVal: Record<string, unknown> = {};

        for (const name of Object.getOwnPropertyNames(val)) {
            outVal[name] = deepClone((val as Record<string, unknown>)[name]);
        }

        return outVal as T;
    }
}