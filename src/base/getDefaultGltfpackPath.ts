export function getDefaultGltfpackPath(): string {
    return `gltfpack${process.platform === 'win32' ? '.exe' : ''}`;
}