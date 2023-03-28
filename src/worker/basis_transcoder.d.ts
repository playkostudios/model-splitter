type CBool = 1 | 0;

interface ImageLevelInfo {
    levelIndex: number;
    layerIndex: number;
    faceIndex: number;
    origWidth: number;
    origHeight: number;
    width: number;
    height: number;
    numBlocksX: number;
    numBlocksY: number;
    totalBlocks: number;
    alphaFlag: CBool;
    iframeFlag: CBool;
}

interface CommonFile {
    delete(): void;
    close(): void;
    getHasAlpha(): CBool;
    isUASTC(): CBool;
    startTranscoding(): CBool;
}

interface BasisFile extends CommonFile {
    getNumImages(): number;
    getNumLevels(imageIndex: number): number;
    getImageWidth(imageIndex: number, levelIndex: number): number;
    getImageHeight(imageIndex: number, levelIndex: number): number;
    getImageTranscodedSizeInBytes(imageIndex: number, levelIndex: number, format: number): number;
    transcodeImage(dst: Uint8Array, imageIndex: number, levelIndex: number, format: number, unused: number, getAlphaForOpaqueFormats: number): CBool;
}

interface KTX2File extends CommonFile {
    isValid(): CBool;
    getWidth(): number;
    getHeight(): number;
    getFaces(): number;
    getLayers(): number;
    getLevels(): number;
    isETC1S(): CBool;
    getImageTranscodedSizeInBytes(levelIndex: number, layerIndex: number, faceIndex: number, format: number): number;
    transcodeImage(dst: Uint8Array, levelIndex: number, layerIndex: number, faceIndex: number, format: number, getAlphaForOpaqueFormats: number, channel0: number, channel1: number): CBool;
    getImageLevelInfo(levelIndex: number, layerIndex: number, faceIndex: number): ImageLevelInfo;
}

type FileCtor<T> = { new (buf: Uint8Array): T };

interface BasisTranscoderModule {
    BasisFile: FileCtor<BasisFile>;
    KTX2File: FileCtor<KTX2File>;
    initializeBasis: () => void;
}

export function BASIS(): Promise<BasisTranscoderModule>;