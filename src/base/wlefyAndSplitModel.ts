import { type Node, type Document, type ILogger } from '@gltf-transform/core';
import { resample, prune, dequantize, metalRough, tangents, unweld, partition, unpartition } from '@gltf-transform/functions';
import { writeFileSync } from 'fs';
import { generateTangents } from 'mikktspace';
import { resolve as resolvePath } from 'node:path';
import { getBoundingBox } from './getBoundingBox';
import { type Metadata } from './output-types';

import type { PatchedNodeIO } from './PatchedNodeIO';

type DocTransformerCallback = (splitName: string | null, doc: Document) => Promise<void> | void;
type ProcessorCallback = (splitName: string | null, glbPath: string, metadata: Metadata) => Promise<void> | void;

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

async function extractAtDepth(logger: ILogger, origDoc: Document, origSceneIdx: number, origSceneChildIdx: number, origNode: Node, depth: number, targetDepth: number, docTransformerCallback: DocTransformerCallback, takenNames: Set<string>) {
    if (depth > targetDepth) {
        // XXX just in case, not really necessary
        return;
    } else if (depth < targetDepth) {
        const nextDepth = depth + 1;
        for (const child of origNode.listChildren()) {
            await extractAtDepth(logger, origDoc, origSceneIdx, origSceneChildIdx, child, nextDepth, targetDepth, docTransformerCallback, takenNames);
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

    // get world transform of target child
    const wPos = target.getWorldTranslation();
    const wRot = target.getWorldRotation();
    const wScale = target.getWorldScale();

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

    // keep world transform as local transform
    target.setTranslation(wPos);
    target.setRotation(wRot);
    target.setScale(wScale);

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

    // add input
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

export async function wlefyAndSplitModel(logger: ILogger, io: PatchedNodeIO, inputModelPath: string, tempFolderPath: string, splitDepth: number, resetPosition: boolean, resetRotation: boolean, resetScale: boolean, processorCallback: ProcessorCallback): Promise<void> {
    // read model
    const origDoc = await io.read(inputModelPath);
    const takenNames = new Set<string>();
    let i = 0;
    const docTransformerCallback: DocTransformerCallback = async (splitName: string | null, doc: Document) => {
        logger.debug('Converting to format usable by Wonderland Engine...');

        // optionally reset parts of root node transform
        if (resetPosition || resetRotation || resetScale) {
            for (const scene of doc.getRoot().listScenes()) {
                for (const child of scene.listChildren()) {
                    if (resetPosition) {
                        child.setTranslation([0,0,0]);
                    }
                    if (resetRotation) {
                        child.setRotation([0,0,0,1]);
                    }
                    if (resetScale) {
                        child.setScale([1,1,1]);
                    }
                }
            }
        }

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

        // generate lod-less metadata (only bounding box data for now)
        const metadata: Metadata = {
            lods: [],
            bounds: getBoundingBox(doc),
        };

        // done
        const outPath = resolvePath(tempFolderPath, `intermediary-model-${i++}.glb`);
        writeFileSync(outPath, await io.writeBinary(doc));
        await processorCallback(splitName, outPath, metadata);
    }

    if (splitDepth === 0) {
        await docTransformerCallback(null, origDoc);
    } else {
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
                await extractAtDepth(logger, origDoc, s, c, child, 1, splitDepth, docTransformerCallback, takenNames);
            }
        }
    }
}