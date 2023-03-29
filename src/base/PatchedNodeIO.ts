import { HTTPUtils, PlatformIO } from '@gltf-transform/core';
import { promises } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';

/**
 * Like NodeIO from gltf-transform, but the 'fs' and 'path' modules are
 * pre-loaded to prevent a crash with dynamic module loading in nw.js
 */
export class PatchedNodeIO extends PlatformIO {
    protected async readURI(uri: string, type: 'view'): Promise<Uint8Array>;
    protected async readURI(uri: string, type: 'text'): Promise<string>;
    protected async readURI(uri: string, type: 'view' | 'text'): Promise<Uint8Array | string> {
        if (HTTPUtils.isAbsoluteURL(uri)) {
            throw new Error('Remote requests are not allowed. Make sure your model only uses local files');
        } else {
            switch (type) {
            case 'view':
                return promises.readFile(uri);
            case 'text':
                return promises.readFile(uri, 'utf8');
            default:
                throw new Error(`Unknown readURI type: ${type}`);
            }
        }
    }

    protected resolve(base: string, path: string): string {
        if (HTTPUtils.isAbsoluteURL(base) || HTTPUtils.isAbsoluteURL(path)) {
            return HTTPUtils.resolve(base, path);
        }
        return resolvePath(base, path);
    }

    protected dirname(uri: string): string {
        if (HTTPUtils.isAbsoluteURL(uri)) {
            return HTTPUtils.dirname(uri);
        }
        return dirname(uri);
    }
}