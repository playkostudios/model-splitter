import { type Document } from '@gltf-transform/core';
import { type BoundingBox } from './output-types';
import { vec3, mat4 } from 'gl-matrix';

export function getBoundingBox(doc: Document): BoundingBox {
    let bounds: BoundingBox | null = null;

    const _updateBounds = (pos: vec3, matrix: mat4) => {
        vec3.transformMat4(pos, pos, matrix);
        bounds![0] = Math.min(bounds![0], pos[0]);
        bounds![1] = Math.min(bounds![1], pos[1]);
        bounds![2] = Math.min(bounds![2], pos[2]);
        bounds![3] = Math.max(bounds![3], pos[0]);
        bounds![4] = Math.max(bounds![4], pos[1]);
        bounds![5] = Math.max(bounds![5], pos[2]);
    };

    const _updateBoundsFirstTime = (pos: vec3, matrix: mat4) => {
        vec3.transformMat4(pos, pos, matrix);
        bounds = [pos[0], pos[1], pos[2], pos[0], pos[1], pos[2]];
        updateBounds = _updateBounds;
    };

    let updateBounds = _updateBoundsFirstTime;

    for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) {
            continue;
        }

        const wMatrix = node.getWorldMatrix();
        const tmp = vec3.create();
        for (const primitive of mesh.listPrimitives()) {
            const accessor = primitive.getAttribute('POSITION');
            if (accessor === null) {
                // XXX no position in primitive? maybe log this
                continue;
            } else if (accessor.getElementSize() !== 3) {
                // XXX wrong element count for position in primitive? log
                continue;
            }

            const indices = primitive.getIndices()?.getArray();
            if (indices) {
                for (const i of indices) {
                    accessor.getElement(i, tmp as number[]);
                    updateBounds(tmp, wMatrix);
                }
            } else {
                const posCount = accessor.getCount();
                for (let i = 0; i < posCount; i++) {
                    accessor.getElement(i, tmp as number[]);
                    updateBounds(tmp, wMatrix);
                }
            }
        }
    }

    if (bounds === null) {
        return [0,0,0,0,0,0];
    } else {
        return bounds;
    }
}