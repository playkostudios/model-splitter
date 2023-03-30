import { resolve as resolvePath } from 'node:path';
import { bufferHash } from './bufferHash';
import sharp from 'sharp';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

import type { PackedResizeOption } from './external-types';
import type { ILogger } from '@gltf-transform/core';

enum TextureCacheType {
    /**
     * Cached texture is present in output folder:
     * - if embedded, read from the output folder and embed into gltf
     * - if external, do nothing, the texture file is already in destination
     */
    Output,
    /**
     * Cached texture is present in temporary folder:
     * - if embedded, read from the temporary folder and embed into gltf
     * - if external, move from temp to output folder and change cache type
     */
    Temp,
}

export class TextureResizer {
    private cachedTextures = new Map<string, TextureCacheType>();
    private cachedOps = new Array<[inputHash: string, outputHash: string, targetWidth: number, targetHeight: number]>();
    private keptExtTextures = new Set<string>();
    private _tempSubFolderPath: string | null = null;
    private warnedTempPartMove = false;

    constructor(private readonly tempFolderPath: string, private readonly logger: ILogger, private allowTempFolderCaching: boolean) {
        if (this.allowTempFolderCaching) {
            this.logger.warn('A temporary folder will be used for caching some resized textures, which may hurt performance');
        }
    }

    private getCachedPath(outFolder: string, hash: string) {
        const cacheType = this.cachedTextures.get(hash);
        let destFolder: string;

        if (cacheType === undefined) {
            throw new Error(`getCachedPath called, but value in cachedTextures is missing for hash "${hash}". This is a bug, please report it`);
        } else if (cacheType === TextureCacheType.Output) {
            destFolder = outFolder;
        } else {
            destFolder = this.tempSubFolderPath;
        }

        return resolvePath(destFolder, hash);
    }

    private getDestFolder(outFolder: string, hash: string, embedded: boolean): string | null {
        if (embedded) {
            if (this.allowTempFolderCaching) {
                return resolvePath(this.tempSubFolderPath, hash);
            } else {
                return null;
            }
        } else {
            return resolvePath(outFolder, hash);
        }
    }

    private writeFile(buf: Uint8Array, path: string | null) {
        if (path === null) {
            return;
        }

        if (!existsSync(path)) {
            this.logger.debug(`Writing image to path "${path}"`);
            writeFileSync(path, buf);
        } else if (!statSync(path).isFile()) {
            throw new Error(`Attempting to write file to "${path}", but folder already exists at destination`);
        } else {
            this.logger.debug(`Skipped writing to file "${path}"; already exists, assuming that the file integrity is OK and the content matches`);
        }
    }

    private moveFile(inPath: string, outPath: string, hash: string) {
        if (inPath === outPath) {
            return;
        }

        try {
            renameSync(inPath, outPath);
        } catch (err) {
            if (err !== null && typeof err === 'object' && (err as Record<string, unknown>).code === 'EXDEV') {
                if (!this.warnedTempPartMove) {
                    this.warnedTempPartMove = true;
                    this.logger.warn('Temporary folder is not in the same partition as the output folder. This may cause performance issues when moving cached textures to the output folder');
                }

                copyFileSync(inPath, outPath);
                rmSync(inPath);
            } else {
                throw err;
            }
        }

        this.cachedTextures.set(hash, TextureCacheType.Output);
    }

    storeExtKTX2(outFolder: string, buf: Uint8Array, hash: string) {
        if (this.keptExtTextures.has(hash)) {
            this.logger.debug(`Skipped writing KTX2 image "${hash}"; already written before`);
            return;
        }

        const path = resolvePath(outFolder, hash);
        this.writeFile(buf, path);
        this.keptExtTextures.add(hash);
    }

    async resizeTexture(outFolder: string, resizeOpt: PackedResizeOption, inBuf: Uint8Array, inHash: string, embedded: boolean): Promise<[buffer: Uint8Array | null, hash: string]> {
        // normalize to 'keep', or percentage-based resize operations to absolute
        // dimensions
        let inSharp: sharp.Sharp | undefined;
        if (Array.isArray(resizeOpt) && resizeOpt[2] === '%') {
            if (resizeOpt[0] === 100 && resizeOpt[1] === 100) {
                resizeOpt = 'keep';
            } else {
                inSharp = sharp(inBuf);
                const inMeta = await inSharp.metadata();
                if (inMeta.width === undefined || inMeta.height === undefined) {
                    throw new Error('Unexpected missing width/height in input image metadata; needed for percentage-based resizing');
                }

                resizeOpt = [
                    Math.round(inMeta.width  * resizeOpt[0] / 100),
                    Math.round(inMeta.height * resizeOpt[1] / 100)
                ];

                if (resizeOpt[0] === inMeta.width && resizeOpt[1] === inMeta.height) {
                    resizeOpt = 'keep';
                }
            }
        }

        // do nothing if "keep"
        if (resizeOpt === 'keep') {
            this.logger.debug(`Image "${inHash}" kept unchanged`);

            if (embedded) {
                this.logger.debug(`Skipped writing kept image "${inHash}"; embedded`);
                return [inBuf, inHash];
            } else {
                if (!this.keptExtTextures.has(inHash)) {
                    this.logger.debug(`Skipped writing kept image "${inHash}"; already written before`);
                } else {
                    this.writeFile(inBuf, this.getDestFolder(outFolder, inHash, embedded));
                    this.keptExtTextures.add(inHash);
                }

                return [null, inHash];
            }
        }

        // reuse cached textures
        const w = resizeOpt[0];
        const h = resizeOpt[1];

        for (const [cInHash, outHash, cW, cH] of this.cachedOps) {
            if (cInHash !== inHash || cW !== w || cH !== h) {
                continue;
            }

            // cached texture matches, reuse
            this.logger.debug(`Image resize operation is cached (input "${inHash}", output "${outHash}", resize ${w}x${h})`);
            const cachePath = this.getCachedPath(outFolder, outHash);

            if (embedded) {
                return [readFileSync(cachePath), outHash];
            } else {
                this.moveFile(cachePath, resolvePath(outFolder, outHash), outHash);
                return [null, outHash];
            }
        }

        // resize with sharp
        this.logger.debug(`Resizing image "${inHash}" to ${w}x${h}`);

        if (inSharp === undefined) {
            inSharp = sharp(inBuf);
        }

        const outBuf = await inSharp.resize(w, h).toBuffer();
        const outHash = bufferHash(outBuf);
        const outPath = this.getDestFolder(outFolder, outHash, embedded);
        this.writeFile(outBuf, outPath);

        if (outPath !== null) {
            this.cachedOps.push([inHash, outHash, w, h]);
            this.cachedTextures.set(outHash, embedded ? TextureCacheType.Temp : TextureCacheType.Output);
        }

        return [embedded ? outBuf : null, outHash];
    }

    get tempSubFolderPath(): string {
        if (this._tempSubFolderPath === null) {
            const newPath = resolvePath(this.tempFolderPath, 'texture-cache');
            mkdirSync(newPath);
            this._tempSubFolderPath = newPath;
        }

        return this._tempSubFolderPath;
    }

    cleanup() {
        this.cachedTextures.clear();
        this.cachedOps.length = 0;
        this.keptExtTextures.clear();
        this.warnedTempPartMove = false;

        if (this._tempSubFolderPath !== null) {
            rmSync(this._tempSubFolderPath, { recursive: true, force: true });
            this._tempSubFolderPath = null;
        }
    }
}