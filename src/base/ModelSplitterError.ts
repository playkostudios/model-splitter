export class ModelSplitterError<T extends string> extends Error {
    isModelSplitterError = true;

    constructor(desc: string, public modelSplitterType: T) {
        super(desc);
    }
}

export class CollisionError extends ModelSplitterError<'collision'> {
    constructor(filePath: string) {
        super(`File "${filePath}" already exists`, 'collision');
    }
}

export class InvalidInputError extends ModelSplitterError<'invalid-input'> {
    constructor(desc: string) {
        super(`Invalid input: ${desc}`, 'invalid-input');
    }
}