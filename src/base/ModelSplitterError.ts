export class ModelSplitterError<T extends string> extends Error {
    isModelSplitterError = true;

    constructor(desc: string, public modelSplitterType: T) {
        super(desc);
    }
}

export class CollisionError extends ModelSplitterError<'collision'> {
    constructor(desc: string) {
        super(desc, 'collision');
    }

    static fromFilePath(filePath: string) {
        return new CollisionError(`File "${filePath}" already exists`);
    }
}

export class InvalidInputError extends ModelSplitterError<'invalid-input'> {
    constructor(desc: string) {
        super(desc, 'invalid-input');
    }

    static fromDesc(desc: string) {
        return new InvalidInputError(`Invalid input: ${desc}`);
    }
}