import { type Node, type Document, type ILogger } from '@gltf-transform/core';
import { resample, prune, dequantize, metalRough, tangents, unweld, partition, unpartition } from '@gltf-transform/functions';
import { writeFileSync } from 'fs';
import { generateTangents } from 'mikktspace';
import { resolve as resolvePath } from 'node:path';
import { type Metadata } from './output-types';

import type { PatchedNodeIO } from './PatchedNodeIO';

type DocTransformerCallback = (splitName: string | null, doc: Document) => Promise<void> | void;
type ProcessorCallback = (splitName: string | null, glbPath: string) => Promise<void> | void;

function traceIdxs(node: Node, idxs: Array<number>) {
    const parent = node.getParentNode();
    if (parent) {
        idxs.push(parent.listChildren().indexOf(node));
        traceIdxs(parent, idxs);
    }
}

function getTargetByIdx(focus: Node, idxs: Array<number>): Node {
    const nextIdx = idxs.pop();
    if (nextIdx === undefined) {
        return focus;
    } else {
        const children = focus.listChildren();
        const child = children[nextIdx];
        if (child === undefined) {
            throw new Error(`Could not find child at index ${nextIdx}`);
        }
        return getTargetByIdx(child, idxs);
    }
}

function scanNodes(focus: Node, visited: Set<Node>) {
    visited.add(focus);

    for (const child of focus.listChildren()) {
        scanNodes(child, visited);
    }
}

async function extractAtDepth(logger: ILogger, origDoc: Document, origSceneIdx: number, origSceneChildIdx: number, origNode: Node, depth: number, targetDepth: number, docTransformerCallback: DocTransformerCallback, metadata: Metadata, takenNames: Set<string>) {
    if (depth > targetDepth) {
        // XXX just in case, not really necessary
        return;
    } else if (depth < targetDepth) {
        const nextDepth = depth + 1;
        for (const child of origNode.listChildren()) {
            await extractAtDepth(logger, origDoc, origSceneIdx, origSceneChildIdx, child, nextDepth, targetDepth, docTransformerCallback, metadata, takenNames);
        }

        return;
    }

    // we are at the target depth, split here
    const origSplitName = origNode.getName();
    logger.debug(`Found wanted node named "${origSplitName}" at depth ${depth}, splitting...`);

    // XXX i know this isn't the most efficient way to do this, but manually
    // copying PART OF a document is pretty hard. instead, i'm going to clone
    // the whole document, and trim out the parts i don't need
    const doc = origDoc.clone();
    const root = doc.getRoot();

    // trim out unwanted scenes
    const scenes = root.listScenes();
    const wantedScene = scenes[origSceneIdx];
    for (let s = scenes.length - 1; s >= 0; s--) {
        const scene = scenes[s];
        if (scene !== wantedScene) {
            scene.detach();
        }
    }
    root.setDefaultScene(wantedScene);

    // find child in cloned scene
    const idxs: Array<number> = [];
    traceIdxs(origNode, idxs);
    const sceneChildren = wantedScene.listChildren();
    const target = getTargetByIdx(sceneChildren[origSceneChildIdx], idxs);

    // move child to top of hirearchy
    target.detach();
    const nodesToKeep = new Set<Node>();
    scanNodes(target, nodesToKeep);

    for (const child of root.listNodes()) {
        if (!nodesToKeep.has(child)) {
            child.dispose();
        }
    }

    wantedScene.addChild(target);

    // make sure child has no local transform
    target.setTranslation([0,0,0]);
    target.setRotation([0,0,0,1]);
    target.setScale([1,1,1]);

    // trim out unused resources (prune)
    doc.transform(
        partition({
            animations: true,
            meshes: true,
        }),
        prune({
            keepAttributes: false,
        }),
        unpartition(),
    );

    // add metadata and input
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    metadata.partLods![origSplitName] = {
        lods: [],
        transform: origNode.getWorldMatrix(),
    };

    let splitName = origSplitName;
    if (takenNames.has(splitName)) {
        for (let i = 2;; i++) {
            splitName = `${origSplitName}-${i}`;
            if (!takenNames.has(splitName)) {
                break;
            }
        }
    }

    if (splitName !== origSplitName) {
        logger.warn(`Name clash for split node "${origSplitName}"; renamed to "${splitName}"`);
    }

    logger.debug(`Done splitting`);

    await docTransformerCallback(splitName, doc);
}

export async function wlefyAndSplitModel(logger: ILogger, io: PatchedNodeIO, inputModelPath: string, tempFolderPath: string, splitDepth: number, metadata: Metadata, processorCallback: ProcessorCallback): Promise<void> {
    // read model
    const origDoc = await io.read(inputModelPath);
    const takenNames = new Set<string>();
    let i = 0;
    const docTransformerCallback: DocTransformerCallback = async (splitName: string | null, doc: Document) => {
        logger.debug('Converting to format usable by Wonderland Engine...');

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
        const outPath = resolvePath(tempFolderPath, `intermediary-model-${i++}.glb`);
        writeFileSync(outPath, await io.writeBinary(doc));
        await processorCallback(splitName, outPath);
    }

    if (splitDepth === 0) {
        metadata.lods = [];
        await docTransformerCallback(null, origDoc);
    } else {
        metadata.partLods = {};
        const root = origDoc.getRoot();
        const scenes = root.listScenes();
        const sceneCount = scenes.length;
        for (let s = 0; s < sceneCount; s++) {
            const scene = scenes[s];
            // XXX not sure if scenes can even have multiple children, but i'm
            // not taking any chances
            const children = scene.listChildren();
            const childCount = children.length;
            for (let c = 0; c < childCount; c++) {
                const child = children[c];
                await extractAtDepth(logger, origDoc, s, c, child, 1, splitDepth, docTransformerCallback, metadata, takenNames);
            }
        }
    }
}