import { type Node, type Document, type ILogger, vec3 as gvec3, vec4 as gvec4 } from '@gltf-transform/core';
import { resample, prune, dequantize, metalRough, tangents, unweld, partition, unpartition, dedup } from '@gltf-transform/functions';
import { writeFileSync } from 'fs';
import { quat, vec3 } from 'gl-matrix';
import { generateTangents } from 'mikktspace';
import { resolve as resolvePath } from 'node:path';
import { getBoundingBox } from './getBoundingBox';
import { type Metadata } from './output-types';

import type { PatchedNodeIO } from './PatchedNodeIO';

type DocTransformerCallback = (splitName: string | null, doc: Document) => Promise<number>;
type ProcessorCallback = (splitName: string | null, glbPath: string, metadata: Metadata) => Promise<number>;
type InstanceCallback = (sourceID: number | null, instanceName: string, position: vec3, rotation: quat, scale: vec3) => void;
type SplitNodeIdxList = Array<[nodeIdx: number, sourceID: number]>;
type TransformCorrection = [posCorrect: gvec3, rotCorrect: gvec4, scaleCorrect: gvec3];

const IS_SUBSCENE_EQUAL_SKIP = new Set(['name', 'translation', 'rotation', 'scale', 'children']);

function scanDescendantNodes(focus: Node, visited: Set<Node>) {
    for (const child of focus.listChildren()) {
        scanDescendantNodes(child, visited);
    }
}

function getTransformCorrection(origNode: Node, resetPosition: boolean, resetRotation: boolean, resetScale: boolean, target: Node | null): TransformCorrection | null {
    let posCorrect: gvec3, rotCorrect: gvec4, scaleCorrect: gvec3,
        needsCorrection = false;
    if (resetPosition) {
        if (target) {
            target.setTranslation([0,0,0]);
        }

        posCorrect = [0,0,0];
    } else {
        posCorrect = origNode.getTranslation();
        vec3.negate(posCorrect, posCorrect);

        if (!vec3.equals(posCorrect, [0,0,0])) {
            needsCorrection = true;
        }
    }

    if (resetRotation) {
        if (target) {
            target.setRotation([0,0,0,1]);
        }

        rotCorrect = [0,0,0,1];
    } else {
        rotCorrect = origNode.getRotation();
        quat.invert(rotCorrect, rotCorrect);

        if (!quat.equals(rotCorrect, [0,0,0,1])) {
            needsCorrection = true;
        }
    }

    if (resetScale) {
        if (target) {
            target.setScale([1,1,1]);
        }

        scaleCorrect = [1,1,1];
    } else {
        scaleCorrect = origNode.getScale();
        vec3.div(scaleCorrect, [1,1,1], scaleCorrect);

        if (!vec3.equals(scaleCorrect, [1,1,1])) {
            needsCorrection = true;
        }
    }

    if (needsCorrection) {
        return [posCorrect, rotCorrect, scaleCorrect];
    } else {
        return null;
    }
}

function isSubsceneEqual(aNode: Node, bNode: Node, ignoreRootName: boolean, ignoreRootPos: boolean, ignoreRootRot: boolean, ignoreRootScale: boolean, aNodeIsDeep: boolean): boolean {
    // compare name
    if (!ignoreRootName && aNode.getName() !== bNode.getName()) {
        return false;
    }

    // compare number of children
    let aNodeChildren: Array<Node>, aNodeChildCount: number;
    if (aNodeIsDeep) {
        aNodeChildren = aNode.listChildren();
        aNodeChildCount = aNodeChildren.length;
    } else {
        aNodeChildren = [];
        aNodeChildCount = 0;
    }

    const bNodeChildren = bNode.listChildren();
    const bNodeChildCount = bNodeChildren.length;

    if (aNodeChildCount !== bNodeChildCount) {
        return false;
    }

    // compare transformation
    if (!ignoreRootPos && !vec3.equals(aNode.getTranslation(), bNode.getTranslation())) {
        return false;
    }

    if (!ignoreRootRot && !quat.equals(aNode.getRotation(), bNode.getRotation())) {
        return false;
    }

    if (!ignoreRootScale && !vec3.equals(aNode.getScale(), bNode.getScale())) {
        return false;
    }

    // compare everything else except children
    if (!aNode.equals(bNode, IS_SUBSCENE_EQUAL_SKIP)) {
        return false;
    }

    // compare children
    for (let i = 0; i < aNodeChildCount; i++) {
        if (!aNodeChildren[i].equals(bNodeChildren[i])) {
            return false;
        }
    }

    return true;
}

function makeInstanceFromNode(instanceCallback: InstanceCallback, sourceID: number | null, origNode: Node, transformCorrection: TransformCorrection | null) {
    // make dummy mode as parent of wanted node to correct for lack of transform
    // reset in model if necessary
    instanceCallback(transformCorrection ? null : sourceID, origNode.getName(), origNode.getTranslation(), origNode.getRotation(), origNode.getScale());
    if (transformCorrection) {
        instanceCallback(sourceID, '', ...transformCorrection);
    }
}

async function extractNode(logger: ILogger, origDoc: Document, origSceneIdx: number, origNode: Node, docTransformerCallback: DocTransformerCallback, instanceCallback: InstanceCallback, takenNames: Set<string>, splitNodeIdxs: SplitNodeIdxList, resetPosition: boolean, resetRotation: boolean, resetScale: boolean, deep: boolean) {
    logger.debug('Checking if node is not a duplicate...');

    // check if child is a duplicate of another child
    const origRoot = origDoc.getRoot();
    const origNodes = origRoot.listNodes();
    const origNodeIdx = origNodes.indexOf(origNode);
    if (origNodeIdx < 0) {
        throw new Error('Node not found in node list; this is a bug, please report it');
    }

    for (const [otherNodeIdx, sourceID] of splitNodeIdxs) {
        const otherNode = origNodes[otherNodeIdx];

        if (isSubsceneEqual(origNode, otherNode, true, resetPosition, resetRotation, resetScale, deep)) {
            logger.debug('Node is a duplicate, skipped');
            const transformCorrect = getTransformCorrection(origNode, resetPosition, resetRotation, resetScale, null);
            makeInstanceFromNode(instanceCallback, sourceID, origNode, transformCorrect);
            return;
        }
    }

    // XXX i know this isn't the most efficient way to do this, but manually
    // copying PART OF a document is pretty hard. instead, i'm going to clone
    // the whole document, and trim out the parts i don't need
    logger.debug(`Not a duplicate, splitting...`);
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
    const nodes = root.listNodes();
    const target = nodes[origNodeIdx];

    // optionally reset parts of target node transform
    const transformCorrect = getTransformCorrection(origNode, resetPosition, resetRotation, resetScale, target);

    // move child to top of hierarchy
    target.detach();
    const nodesToKeep = new Set<Node>([target]);
    if (deep) {
        scanDescendantNodes(target, nodesToKeep);
    }

    for (const child of nodes) {
        if (!nodesToKeep.has(child)) {
            child.dispose();
        }
    }

    wantedScene.addChild(target);

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
    const origSplitName = origNode.getName();
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

    const sourceID = await docTransformerCallback(splitName, doc);
    splitNodeIdxs.push([origNodeIdx, sourceID]);
    makeInstanceFromNode(instanceCallback, sourceID, origNode, transformCorrect);
}

async function extractAtDepth(logger: ILogger, origDoc: Document, origSceneIdx: number, origNode: Node, depth: number, targetDepth: number, depthOffset: number, docTransformerCallback: DocTransformerCallback, instanceCallback: InstanceCallback, takenNames: Set<string>, splitNodeIdxs: SplitNodeIdxList, resetPosition: boolean, resetRotation: boolean, resetScale: boolean) {
    if (depth === targetDepth) {
        // we are at the target depth, split here
        logger.debug(`Found wanted deep node named "${origNode.getName()}" at target depth (${depth + depthOffset})`);
        await extractNode(logger, origDoc, origSceneIdx, origNode, docTransformerCallback, instanceCallback, takenNames, splitNodeIdxs, resetPosition, resetRotation, resetScale, true);
    } else if (depth < targetDepth) {
        // shallow-split
        if (origNode.getMesh()) {
            logger.debug(`Found shallow parent node named "${origNode.getName()}" above target depth (${depth + depthOffset})`);
            await extractNode(logger, origDoc, origSceneIdx, origNode, docTransformerCallback, instanceCallback, takenNames, splitNodeIdxs, resetPosition, resetRotation, resetScale, false)
        } else {
            makeInstanceFromNode(instanceCallback, null, origNode, null);
        }

        // split children
        const nextDepth = depth + 1;
        for (const child of origNode.listChildren()) {
            await extractAtDepth(logger, origDoc, origSceneIdx, child, nextDepth, targetDepth, depthOffset, docTransformerCallback, instanceCallback, takenNames, splitNodeIdxs, resetPosition, resetRotation, resetScale);
        }
    }
}

function enumerateAtDepth(node: Node, depth: number, targetDepth: number, targetList: Array<Node>, parentList: Array<Node>) {
    if (depth === targetDepth) {
        // we are at the target depth, add to list and stop traversing
        targetList.push(node);
        return;
    } else {
        // traverse children
        parentList.push(node);
        const nextDepth = depth + 1;
        for (const child of node.listChildren()) {
            enumerateAtDepth(child, nextDepth, targetDepth, targetList, parentList);
        }
    }
}

export async function wlefyAndSplitModel(logger: ILogger, io: PatchedNodeIO, inputModelPath: string, tempFolderPath: string, splitDepth: number, discardDepthSplitParentNodes: boolean, resetPosition: boolean, resetRotation: boolean, resetScale: boolean, processorCallback: ProcessorCallback, instanceCallback: InstanceCallback): Promise<void> {
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

        // generate lod-less metadata (only bounding box data for now)
        const metadata: Metadata = {
            lods: [],
            bounds: getBoundingBox(doc),
        };

        // done
        const outPath = resolvePath(tempFolderPath, `intermediary-model-${i++}.glb`);
        writeFileSync(outPath, await io.writeBinary(doc));
        return await processorCallback(splitName, outPath, metadata);
    }

    if (splitDepth === 0) {
        // optionally reset parts of root child nodes' transforms
        // XXX resetting transforms in a 0 split depth configuration will always
        //     make a broken instance group, since this configuration is used
        //     for making catalogues, and it doesn't really make sense for
        //     people to want to make an instance group out of a catalogue
        //     (since it's guaranteed to be one model file instead of many)
        const origRoot = origDoc.getRoot();
        if (resetPosition || resetRotation || resetScale) {
            for (const scene of origRoot.listScenes()) {
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

        const sourceID = await docTransformerCallback(null, origDoc);
        instanceCallback(sourceID, origRoot.getDefaultScene()?.getName() ?? 'root', [0,0,0], [0,0,0,1], [1,1,1]);
    } else {
        // discard parent nodes if wanted, but keep child nodes with the same
        // world transform
        let depthOffset = 0;
        if (discardDepthSplitParentNodes && splitDepth > 1) {
            logger.warn(`Discarding parent nodes ${splitDepth === 2 ? 'at depth 1' : `at the depth range [1:${splitDepth - 1}]`}...`);

            const root = origDoc.getRoot();
            const scenes = root.listScenes();
            for (const scene of scenes) {
                // get nodes at target depth
                const sceneNodesToKeep = new Array<Node>();
                const sceneNodesToDispose = new Array<Node>();
                for (const child of scene.listChildren()) {
                    enumerateAtDepth(child, 1, splitDepth, sceneNodesToKeep, sceneNodesToDispose);
                }

                // move target nodes to top of hierarchy, and keep their world
                // transform
                for (const node of sceneNodesToKeep) {
                    const wPos = node.getWorldTranslation();
                    const wRot = node.getWorldRotation();
                    const wScale = node.getWorldScale();
                    node.setTranslation(wPos);
                    node.setRotation(wRot);
                    node.setScale(wScale);
                    scene.addChild(node);
                }

                for (const node of sceneNodesToDispose) {
                    node.dispose();
                }
            }

            // shift target depth now that we changed the scene graph
            depthOffset = splitDepth - 1;
            splitDepth = 1;
        }

        // deduplicate document so that duplicate child detection doesn't fail
        await origDoc.transform(
            prune({
                keepAttributes: false,
            }),
            dedup(),
        );

        // split document into multiple sub-documents with a child per document
        const root = origDoc.getRoot();
        const scenes = root.listScenes();
        const sceneCount = scenes.length;
        const splitNodeIdxs: SplitNodeIdxList = [];
        for (let s = 0; s < sceneCount; s++) {
            const scene = scenes[s];
            for (const child of scene.listChildren()) {
                await extractAtDepth(logger, origDoc, s, child, 1, splitDepth, depthOffset, docTransformerCallback, instanceCallback, takenNames, splitNodeIdxs, resetPosition, resetRotation, resetScale);
            }
        }
    }
}