import { resample, prune, dequantize, metalRough, tangents, unweld } from '@gltf-transform/functions';
import { generateTangents } from 'mikktspace';

import type { PatchedNodeIO } from './PatchedNodeIO';

export async function wlefyModel(io: PatchedNodeIO, inputModelPath: string): Promise<Uint8Array> {
    // read model
    const doc = await io.read(inputModelPath);

    // get rid of extensions not supported by wonderland engine and do some
    // extra optimizations
    await doc.transform(
        resample(),
        dequantize(),
        metalRough(),
        unweld(),
        tangents({ generateTangents, overwrite: false }),
        prune(),
    );

    // done
    return await io.writeBinary(doc);
}