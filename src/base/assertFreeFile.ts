import { existsSync } from 'node:fs';
import { CollisionError } from './ModelSplitterError';

export function assertFreeFile(filePath: string) {
    if (existsSync(filePath)) {
        throw CollisionError.fromFilePath(filePath);
    }
}