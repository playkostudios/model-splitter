import { resample, prune, dequantize, metalRough, tangents, unweld } from '@gltf-transform/functions';
import { writeFileSync } from 'fs';
import { generateTangents } from 'mikktspace';
import { resolve as resolvePath } from 'node:path';

import type { PatchedNodeIO } from './PatchedNodeIO';

export async function wlefyModel(io: PatchedNodeIO, inputModelPath: string, tempFolderPath: string): Promise<string> {
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
    const outPath = resolvePath(tempFolderPath, 'intermediary-model.glb');
    writeFileSync(outPath, await io.writeBinary(doc));
    return outPath;
}