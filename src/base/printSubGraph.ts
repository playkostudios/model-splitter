import { Scene, type Node, type ILogger } from '@gltf-transform/core';
import { graphNodeToString } from './graphNodeToString';

export function printSubGraph(logger: ILogger, target: Scene | Node, depth = 0) {
    const nodeStr = graphNodeToString(target);
    logger.debug(depth > 0 ? `${'  '.repeat(depth - 1)}- ${nodeStr}` : nodeStr);

    for (const child of target.listChildren()) {
        printSubGraph(logger, child, depth + 1);
    }
}