import { type Document, type Mesh, Node, Primitive } from '@gltf-transform/core';
import { PrefixedLogger } from './PrefixedLogger';
import { mat4 } from 'gl-matrix';
import { type WeldOptions, weldPrimitive } from '@gltf-transform/functions';

export const NWO_TRANS_NAME = 'normalize-winding-order';

function invertMeshWindingOrder(doc: Document, mesh: Mesh) {
    let didWork = false;
    for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== Primitive.Mode.TRIANGLES) {
            continue;
        }

        let indicesAccessor = prim.getIndices();
        if (!indicesAccessor) {
            weldPrimitive(doc, prim, <Required<WeldOptions>>{ tolerance: 0 });
            indicesAccessor = prim.getIndices()!;
        }

        const indices = indicesAccessor.getArray()!;
        const indexCount = indices.length;
        for (let i = 0; i < indexCount; i += 3) {
            const temp = indices[i];
            indices[i] = indices[i + 1];
            indices[i + 1] = temp;
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

        if (invertCount === 1) {
            if (invertMeshWindingOrder(doc, mesh)) {
                logger.warn(`Mesh ${m} is used in a single mirrored object. Inverted mesh winding order`);
            }
        } else {
            // TODO make copy of mesh, invert it, and replace mesh in nodes with
            //      copy
        }
        console.debug(nodes, invertNodes);
    }
}