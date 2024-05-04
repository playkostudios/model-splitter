export type FileSignature = ReadonlyArray<ReadonlyArray<readonly [offset: number, bytes: Readonly<Uint8Array>]>>;

export function bufferHasMagic(buffer: Readonly<Uint8Array>, signature: FileSignature): boolean {
    // XXX check if ONE of the signatures matches
    for (const sigBytesGroup of signature) {
        let matches = true;

        // XXX check that ALL byte sequences of this signature matches
        for (const [offset, sigBytes] of sigBytesGroup) {
            const sigByteCount = sigBytes.byteLength;
            const end = offset + sigByteCount;
            if (buffer.length < end) {
                matches = false;
                break;
            }

            for (let s = 0, i = offset; s < sigByteCount; s++, i++) {
                if (sigBytes[s] !== buffer[i]) {
                    matches = false;
                    break;
                }
            }

            if (!matches) {
                break;
            }
        }

        if (matches) {
            return true;
        }
    }

    return false;
}