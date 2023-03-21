import { NodeIO } from '@gltf-transform/core';
import { resample, prune, dedup, dequantize, metalRough } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

export async function wlefyModel(inputModelPath: string): Promise<Uint8Array> {
    // read model
    const io = new NodeIO();
    io.registerExtensions(KHRONOS_EXTENSIONS);
    io.registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
    });

    const doc = await io.read(inputModelPath);

    // get rid of extensions not supported by wonderland engine and do some
    // extra optimizations
    await doc.transform(
        resample(),
        dequantize(),
        metalRough(),
        prune(),
        dedup(),
    );

    // done
    return await io.writeBinary(doc);
}