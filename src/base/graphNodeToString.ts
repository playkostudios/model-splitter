import { Scene, type Node } from '@gltf-transform/core';

export function graphNodeToString(node: Scene | Node) {
    return `${(node instanceof Scene) ? '<scene>"' : '<node>"'}${node.getName()}"`;
}