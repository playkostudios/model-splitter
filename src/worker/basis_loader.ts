import { BASIS } from './basis_transcoder';

import type { SupportedFormats } from '../browser/SupportedFormats';
import type { FileCtor, BasisFile, KTX2File, CommonFile, CBool } from './basis_transcoder';

/**
 * Modified Basis Universal loader. Modified to:
 * - converted to Typescript
 * - removed client code (moved to separate script)
 * - simplified code for use with Wonderland Engine
 * - only contain worker code
 * - disallow separate alpha texture
 * - support ktx2 files
 *
 * https://github.com/BinomialLLC/basis_universal/tree/master/webgl/transcoder/build/basis_loader.js
 */

// Copied from enum class transcoder_texture_format in basisu_transcoder.h with minor javascript-ification
enum TranscoderFormat {
    // Compressed formats
    // ETC1-2
    cTFETC1_RGB = 0,  // Opaque only, returns RGB or alpha data if cDecodeFlagsTranscodeAlphaDataToOpaqueFormats flag is specified
    cTFETC2_RGBA = 1, // Opaque+alpha, ETC2_EAC_A8 block followed by a ETC1 block, alpha channel will be opaque for opaque .basis files
    // BC1-5, BC7 (desktop, some mobile devices)
    cTFBC1_RGB = 2,  // Opaque only, no punchthrough alpha support yet, transcodes alpha slice if cDecodeFlagsTranscodeAlphaDataToOpaqueFormats flag is specified
    cTFBC3_RGBA = 3, // Opaque+alpha, BC4 followed by a BC1 block, alpha channel will be opaque for opaque .basis files
    cTFBC4_R = 4,    // Red only, alpha slice is transcoded to output if cDecodeFlagsTranscodeAlphaDataToOpaqueFormats flag is specified
    cTFBC5_RG = 5,   // XY: Two BC4 blocks, X=R and Y=Alpha, .basis file should have alpha data (if not Y will be all 255's)
    cTFBC7_RGBA = 6, // RGB or RGBA, mode 5 for ETC1S, modes (1,2,3,5,6,7) for UASTC
    // PVRTC1 4bpp (mobile, PowerVR devices)
    cTFPVRTC1_4_RGB = 8,  // Opaque only, RGB or alpha if cDecodeFlagsTranscodeAlphaDataToOpaqueFormats flag is specified, nearly lowest quality of any texture format.
    cTFPVRTC1_4_RGBA = 9, // Opaque+alpha, most useful for simple opacity maps. If .basis file doesn't have alpha cTFPVRTC1_4_RGB will be used instead. Lowest quality of any supported texture format.
    // ASTC (mobile, Intel devices, hopefully all desktop GPU's one day)
    cTFASTC_4x4_RGBA = 10, // Opaque+alpha, ASTC 4x4, alpha channel will be opaque for opaque .basis files. Transcoder uses RGB/RGBA/L/LA modes, void extent, and up to two ([0,47] and [0,255]) endpoint precisions.
    // Uncompressed (raw pixel) formats
    cTFRGBA32 = 13,   // 32bpp RGBA image stored in raster (not block) order in memory, R is first byte, A is last byte.
    cTFRGB565 = 14,   // 166pp RGB image stored in raster (not block) order in memory, R at bit position 11
    cTFBGR565 = 15,   // 16bpp RGB image stored in raster (not block) order in memory, R at bit position 0
    cTFRGBA4444 = 16, // 16bpp RGBA image stored in raster (not block) order in memory, R at bit position 12, A at bit position 0
}

let BasisFile: FileCtor<BasisFile>, KTX2File: FileCtor<KTX2File>;

const BASIS_INITIALIZED = BASIS().then((module) => {
    BasisFile = module.BasisFile;
    KTX2File = module.KTX2File;
    module.initializeBasis();
});

// WebGL compressed formats types, from:
// http://www.khronos.org/registry/webgl/extensions/

// https://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_s3tc/
const COMPRESSED_RGB_S3TC_DXT1_EXT  = 0x83F0;
const COMPRESSED_RGBA_S3TC_DXT5_EXT = 0x83F3;
// https://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_etc1/
const COMPRESSED_RGB_ETC1_WEBGL = 0x8D64;
// https://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_etc/
const COMPRESSED_RGBA8_ETC2_EAC = 0x9278;
// https://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_astc/
const COMPRESSED_RGBA_ASTC_4x4_KHR = 0x93B0;
// https://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_pvrtc/
const COMPRESSED_RGB_PVRTC_4BPPV1_IMG = 0x8C00;
const COMPRESSED_RGBA_PVRTC_4BPPV1_IMG = 0x8C02;
// https://www.khronos.org/registry/webgl/extensions/EXT_texture_compression_bptc/
const COMPRESSED_RGBA_BPTC_UNORM_EXT = 0x8E8C;

const BASIS_WEBGL_FORMAT_MAP = {
    // Compressed formats
    [TranscoderFormat.cTFBC1_RGB]: { format: COMPRESSED_RGB_S3TC_DXT1_EXT },
    [TranscoderFormat.cTFBC3_RGBA]: { format: COMPRESSED_RGBA_S3TC_DXT5_EXT },
    [TranscoderFormat.cTFBC7_RGBA]: { format: COMPRESSED_RGBA_BPTC_UNORM_EXT },
    [TranscoderFormat.cTFETC1_RGB]: { format: COMPRESSED_RGB_ETC1_WEBGL },
    [TranscoderFormat.cTFETC2_RGBA]: { format: COMPRESSED_RGBA8_ETC2_EAC },
    [TranscoderFormat.cTFASTC_4x4_RGBA]: { format: COMPRESSED_RGBA_ASTC_4x4_KHR },
    [TranscoderFormat.cTFPVRTC1_4_RGB]: { format: COMPRESSED_RGB_PVRTC_4BPPV1_IMG },
    [TranscoderFormat.cTFPVRTC1_4_RGBA]: { format: COMPRESSED_RGBA_PVRTC_4BPPV1_IMG },

    // Uncompressed formats
    [TranscoderFormat.cTFRGBA32]: { uncompressed: true, format: WebGLRenderingContext.RGBA, type: WebGLRenderingContext.UNSIGNED_BYTE },
    [TranscoderFormat.cTFRGB565]: { uncompressed: true, format: WebGLRenderingContext.RGB, type: WebGLRenderingContext.UNSIGNED_SHORT_5_6_5 },
    [TranscoderFormat.cTFRGBA4444]: { uncompressed: true, format: WebGLRenderingContext.RGBA, type: WebGLRenderingContext.UNSIGNED_SHORT_4_4_4_4 },
};

// Notifies the main thread when a texture has failed to load for any reason.
function fail(id: number, errorMsg: string) {
    postMessage({
        id: id,
        error: errorMsg
    });
}

function fileFail(id: number, basisOrKtx2File: CommonFile, errorMsg: string) {
    fail(id, errorMsg);
    basisOrKtx2File.close();
    basisOrKtx2File.delete();
}

// This utility currently only transcodes the first image in the file.
const IMAGE_INDEX = 0;

function transcode(id: number, arrayBuffer: ArrayBuffer, supportedFormats: SupportedFormats) {
    const fileData = new Uint8Array(arrayBuffer);
    const ktx2Magic = [0xAB,0x4B,0x54,0x58,0x20,0x32,0x30,0xBB,0x0D,0x0A,0x1A,0x0A];
    let isKTX2 = false;

    if (arrayBuffer.byteLength >= 12) {
        isKTX2 = true;
        for (let i = 0; i < 12; i++) {
            if (fileData[i] !== ktx2Magic[i]) {
                isKTX2 = false;
                break;
            }
        }
    }

    let file: BasisFile | KTX2File, levels: number;
    if (isKTX2) {
        file = new KTX2File(fileData);
        levels = file.getLevels();
        const width = file.getWidth();
        const height = file.getHeight();

        if (!width || !height || !levels) {
            fileFail(id, file, 'Invalid KTX2 data');
            return;
        }
    } else {
        file = new BasisFile(fileData);
        levels = file.getNumLevels(IMAGE_INDEX);
        const images = file.getNumImages();

        if (!images || !levels) {
            fileFail(id, file, 'Invalid Basis data');
            return;
        }
    }

    if (!file.startTranscoding()) {
        fileFail(id, file, 'startTranscoding failed');
        return;
    }

    const hasAlpha = file.getHasAlpha();
    let transFormat: TranscoderFormat;

    if (hasAlpha) {
        if (supportedFormats.etc2) {
            transFormat = TranscoderFormat.cTFETC2_RGBA;
        } else if (supportedFormats.bptc) {
            transFormat = TranscoderFormat.cTFBC7_RGBA;
        } else if (supportedFormats.s3tc) {
            transFormat = TranscoderFormat.cTFBC3_RGBA;
        } else if (supportedFormats.astc) {
            transFormat = TranscoderFormat.cTFASTC_4x4_RGBA;
        } else if (supportedFormats.pvrtc) {
            transFormat = TranscoderFormat.cTFPVRTC1_4_RGBA;
        } else {
            // If we don't support any appropriate compressed formats transcode to
            // raw pixels. This is something of a last resort, because the GPU
            // upload will be significantly slower and take a lot more memory, but
            // at least it prevents you from needing to store a fallback JPG/PNG and
            // the download size will still likely be smaller.
            transFormat = TranscoderFormat.cTFRGBA32;
        }
    } else {
        if (supportedFormats.etc1) {
            // Should be the highest quality, so use when available.
            // http://richg42.blogspot.com/2018/05/basis-universal-gpu-texture-format.html
            transFormat = TranscoderFormat.cTFETC1_RGB;
        } else if (supportedFormats.bptc) {
            transFormat = TranscoderFormat.cTFBC7_RGBA;
        } else if (supportedFormats.s3tc) {
            transFormat = TranscoderFormat.cTFBC1_RGB;
        } else if (supportedFormats.etc2) {
            transFormat = TranscoderFormat.cTFETC2_RGBA;
        } else if (supportedFormats.astc) {
            transFormat = TranscoderFormat.cTFASTC_4x4_RGBA;
        } else if (supportedFormats.pvrtc) {
            transFormat = TranscoderFormat.cTFPVRTC1_4_RGB;
        } else {
            // See note on uncompressed transcode above.
            transFormat = TranscoderFormat.cTFRGB565;
        }
    }

    if (transFormat === undefined) {
        fileFail(id, file, 'No supported transcode formats');
        return;
    }

    const webglFormat = BASIS_WEBGL_FORMAT_MAP[transFormat];

    // transcode first mip level. only first mip level is used because we aren't
    // going to render these textures directly in 3D. we're going to transfer
    // them to wonderland engine as a canvas
    let transcodeSize: number, width: number, height: number;
    if (isKTX2) {
        const ktx2File = file as KTX2File;
        const levelInfo = ktx2File.getImageLevelInfo(0, IMAGE_INDEX, 0);
        width = levelInfo.origWidth < 4 ? levelInfo.origWidth : levelInfo.width;
        height = levelInfo.origHeight < 4 ? levelInfo.origHeight : levelInfo.height;
        transcodeSize = ktx2File.getImageTranscodedSizeInBytes(0, IMAGE_INDEX, 0, transFormat);
    } else {
        const basisFile = file as BasisFile;
        width = basisFile.getImageWidth(IMAGE_INDEX, 0);
        height = basisFile.getImageHeight(IMAGE_INDEX, 0);
        transcodeSize = basisFile.getImageTranscodedSizeInBytes(IMAGE_INDEX, 0, transFormat);
    }

    const transcodeData = new Uint8Array(transcodeSize);

    let transcodeOK: CBool;
    if (isKTX2) {
        transcodeOK = (file as KTX2File).transcodeImage(transcodeData, 0, IMAGE_INDEX, 0, transFormat, 0, -1, -1);
    } else {
        transcodeOK = (file as BasisFile).transcodeImage(transcodeData, IMAGE_INDEX, 0, transFormat, 1, 0);
    }

    if (!transcodeOK) {
        fileFail(id, file, 'transcodeImage failed');
        return;
    }

    file.close();
    file.delete();

    // Post the transcoded results back to the main thread.
    postMessage({
        id,
        buffer: transcodeData.buffer,
        webglFormat,
        transcodeSize,
        width,
        height,
        hasAlpha,
    }, [transcodeData.buffer]);
}

onmessage = (msg) => {
    // Each call to the worker must contain:
    const url: string = msg.data.url; // The URL of the basis image OR
    const buffer: ArrayBuffer = msg.data.buffer; // An array buffer with the basis image data
    const supportedFormats: SupportedFormats = msg.data.supportedFormats; // The formats this device supports
    const id: number = msg.data.id; // A unique ID for the texture

    if (url) {
        // Make the call to fetch the basis texture data
        fetch(url).then(function(response) {
            if (response.ok) {
                response.arrayBuffer().then((arrayBuffer) => {
                    if (BasisFile) {
                        transcode(id, arrayBuffer, supportedFormats);
                    } else {
                        BASIS_INITIALIZED.then(() => {
                            transcode(id, arrayBuffer, supportedFormats);
                        });
                    }
                });
            } else {
                fail(id, `Fetch failed: ${response.status}, ${response.statusText}`);
            }
        });
    } else if (buffer) {
        if (BasisFile) {
            transcode(id, buffer, supportedFormats);
        } else {
            BASIS_INITIALIZED.then(() => {
                transcode(id, buffer, supportedFormats);
            });
        }
    } else {
        fail(id, `No url or buffer specified`);
    }
};
