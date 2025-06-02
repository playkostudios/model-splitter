import { type Document, type Mesh, Node, Primitive, type TypedArray } from '@gltf-transform/core';
import { PrefixedLogger } from './PrefixedLogger';
import { mat4 } from 'gl-matrix';
import { type WeldOptions, weldPrimitive } from '@gltf-transform/functions';

export const NWO_TRANS_NAME = 'normalize-winding-order';

function invertMeshWindingOrder(doc: Document, mesh: Mesh, clone: boolean) {
    let didWork = false;
    for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== Primitive.Mode.TRIANGLES) {
            continue;
        }

        let actualPrim: Primitive;
        if (clone) {
            actualPrim = prim.clone();
        } else {
            actualPrim = prim;
        }

        let indicesAccessor = actualPrim.getIndices();
        let indicesInput: TypedArray, indicesOutput: TypedArray;
        if (!indicesAccessor) {
            weldPrimitive(doc, actualPrim, <Required<WeldOptions>>{ tolerance: 0 });
            indicesAccessor = actualPrim.getIndices()!;
            indicesOutput = indicesInput = indicesAccessor.getArray()!;
        } else if (clone) {
            indicesInput = indicesAccessor.getArray()!;
            indicesOutput = indicesInput.slice();
            indicesAccessor = doc.createAccessor()
                .setArray(indicesOutput)
                .setType('SCALAR')
                .setBuffer(doc.createBuffer());
        } else {
            indicesOutput = indicesInput = indicesAccessor.getArray()!;
        }

        const indexCount = indicesInput.length;
        for (let i = 0; i < indexCount; i += 3) {
            const temp = indicesInput[i];
            indicesOutput[i] = indicesInput[i + 1];
            indicesOutput[i + 1] = temp;
        }

        didWork = true;
    }

    return didWork;
}

export function normalizeWindingOrderTransform(doc: Document) {
    const logger = new PrefixedLogger(`${NWO_TRANS_NAME}: `, doc.getLogger());
    const root = doc.getRoot();
    const meshes = root.listMeshes();

    for (let m = 0; m < meshes.length; m++) {
        const mesh = meshes[m];
        const nodes = mesh.listParents().filter((p) => p instanceof Node) as Node[];
        const invertNodes: Node[] = [];

        for (const node of nodes) {
            if (mat4.determinant(node.getWorldMatrix()) < 0) {
                invertNodes.push(node);
            }
        }

        const invertCount = invertNodes.length;
        if (invertCount === 0) {
            continue;
        }

        if (invertCount === nodes.length) {
            if (invertMeshWindingOrder(doc, mesh, false)) {
                logger.warn(`Mesh ${m} is only used in mirrored objects. Inverted mesh winding order`);
            }
        } else {
            const invertedMesh = mesh.clone();
            if (invertMeshWindingOrder(doc, invertedMesh, true)) {
                logger.warn(`Mesh ${m} is used in some mirrored objects. Cloned and inverted mesh winding order`);
            }

            for (const node of invertNodes) {
                node.setMesh(invertedMesh);
            }
        }
    }
}