import type { PackedResizeOption, DefaultablePackedResizeOption } from './lib';
import type { ResizeOption } from 'gm';

export function parseTextureSize(inStr: string, allowDefault: false): PackedResizeOption;
export function parseTextureSize(inStr: string, allowDefault: true): DefaultablePackedResizeOption;
export function parseTextureSize(inStr: string, allowDefault: boolean): DefaultablePackedResizeOption {
    if (inStr === 'default') {
        if (!allowDefault) {
            throw new Error(`Default texture size is disallowed for this option`);
        }

        return 'default';
    } else if (inStr === 'keep') {
        return 'keep';
    } else {
        let texSizeStr = inStr;
        let option: ResizeOption = '!';
        if (texSizeStr.endsWith('%') || texSizeStr.endsWith('!')) {
            const end = texSizeStr.length - 1;
            option = texSizeStr[end] as '%' | '!';
            texSizeStr = texSizeStr.substring(0, end);
        }

        const parts = texSizeStr.split(/[x,]/);
        if (parts.length <= 0 || parts.length > 2) {
            throw new Error(`Invalid texture size (${inStr})`);
        }

        const partsNum = new Array<number>();
        for (const part of parts) {
            const num = Number(part);
            if (isNaN(num) || !isFinite(num) || num <= 0) {
                throw new Error(`Invalid texture size (${inStr})`);
            }

            if (option === '!' && num !== Math.trunc(num)) {
                throw new Error(`Invalid texture size (${inStr})`);
            }

            partsNum.push(num);
        }

        return [partsNum[0], parts.length === 2 ? partsNum[1] : partsNum[0], option];
    }
}