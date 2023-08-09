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

function getTransformCorrection(origNode: Node, resetPosition: boolean, resetRotation: boolean, resetScale: boolean, discardDepthSplitParentNodes: boolean, target: Node | null): TransformCorrection | null {
    let posCorrect: gvec3, rotCorrect: gvec4, scaleCorrect: gvec3,
        needsCorrection = false;
    if (resetPosition) {
        if (target) {
            target.setTranslation([0,0,0]);
        }

        posCorrect = [0,0,0];
    } else {
        if (discardDepthSplitParentNodes) {
            posCorrect = origNode.getWorldTranslation();
        } else {
            posCorrect = origNode.getTranslation();
        }

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
        if (discardDepthSplitParentNodes) {
            rotCorrect = origNode.getWorldRotation();
        } else {
            rotCorrect = origNode.getRotation();
        }

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
        if (discardDepthSplitParentNodes) {
            scaleCorrect = origNode.getWorldScale();
        } else {
            scaleCorrect = origNode.getScale();
        }

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

function isSubsceneEqual(aNode: Node, bNode: Node, ignoreRootName: boolean, ignoreRootPos: boolean, ignoreRootRot: boolean, ignoreRootScale: boolean, compareRootWorldTransform: boolean, aNodeIsDeep: boolean): boolean {
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
    if (!ignoreRootPos) {
        if (compareRootWorldTransform) {
            if (!vec3.equals(aNode.getWorldTranslation(), bNode.getWorldTranslation())) {
                return false;
            }
        } else if (!vec3.equals(aNode.getTranslation(), bNode.getTranslation())) {
            return false;
        }
    }

    if (!ignoreRootRot) {
        if (compareRootWorldTransform) {
            if (!quat.equals(aNode.getWorldRotation(), bNode.getWorldRotation())) {
                return false;
            }
        } else if (!quat.equals(aNode.getRotation(), bNode.getRotation())) {
            return false;
        }
    }

    if (!ignoreRootScale) {
        if (compareRootWorldTransform) {
            if (!vec3.equals(aNode.getWorldScale(), bNode.getWorldScale())) {
                return false;
            }
        } else if (!vec3.equals(aNode.getScale(), bNode.getScale())) {
            return false;
        }
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

function makeInstanceFromNode(instanceCallback: InstanceCallback, sourceID: number | null, origNode: Node, useWorldTransform: boolean, transformCorrection: TransformCorrection | null) {
    const position = useWorldTransform ? origNode.getWorldTranslation() : origNode.getTranslation();
    const rotation = useWorldTransform ? origNode.getWorldRotation() : origNode.getRotation();
    const scale = useWorldTransform ? origNode.getWorldScale() : origNode.getScale();

    if (transformCorrection) {
        // make dummy mode as parent of wanted node to correct for lack of
        // transform reset in model
        instanceCallback(null, origNode.getName(), position, rotation, scale);
        instanceCallback(sourceID, '', ...transformCorrection);
    } else {
        instanceCallback(sourceID, origNode.getName(), position, rotation, scale);
    }
}

async function extractNode(logger: ILogger, origDoc: Document, origSceneIdx: number, origNode: Node, discardDepthSplitParentNodes: boolean, docTransformerCallback: DocTransformerCallback, instanceCallback: InstanceCallback, takenNames: Set<string>, splitNodeIdxs: SplitNodeIdxList, resetPosition: boolean, resetRotation: boolean, resetScale: boolean, deep: boolean) {
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

        if (isSubsceneEqual(origNode, otherNode, true, resetPosition, resetRotation, resetScale, discardDepthSplitParentNodes, deep)) {
            logger.debug('Node is a duplicate, skipped');
            const transformCorrect = getTransformCorrection(origNode, resetPosition, resetRotation, resetScale, discardDepthSplitParentNodes, null);
            makeInstanceFromNode(instanceCallback, sourceID, origNode, discardDepthSplitParentNodes, transformCorrect);
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
    const transformCorrect = getTransformCorrection(origNode, resetPosition, resetRotation, resetScale, discardDepthSplitParentNodes, target);

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
    makeInstanceFromNode(instanceCallback, sourceID, origNode, discardDepthSplitParentNodes, transformCorrect);
}

async function extractAtDepth(logger: ILogger, origDoc: Document, origSceneIdx: number, origNode: Node, depth: number, targetDepth: number, discardDepthSplitParentNodes: boolean, docTransformerCallback: DocTransformerCallback, instanceCallback: InstanceCallback, takenNames: Set<string>, splitNodeIdxs: SplitNodeIdxList, resetPosition: boolean, resetRotation: boolean, resetScale: boolean) {
    if (depth === targetDepth) {
        // we are at the target depth, split here
        logger.debug(`Found wanted deep node named "${origNode.getName()}" at target depth (${depth})`);
        await extractNode(logger, origDoc, origSceneIdx, origNode, discardDepthSplitParentNodes, docTransformerCallback, instanceCallback, takenNames, splitNodeIdxs, resetPosition, resetRotation, resetScale, true);
    } else if (depth < targetDepth) {
        // shallow-split if not discarding parent nodes
        if (!discardDepthSplitParentNodes) {
            if (origNode.getMesh()) {
                logger.debug(`Found shallow parent node named "${origNode.getName()}" above target depth (${depth})`);
                await extractNode(logger, origDoc, origSceneIdx, origNode, discardDepthSplitParentNodes, docTransformerCallback, instanceCallback, takenNames, splitNodeIdxs, resetPosition, resetRotation, resetScale, false)
            } else {
                makeInstanceFromNode(instanceCallback, null, origNode, false, null);
            }
        }

        // split children
        const nextDepth = depth + 1;
        for (const child of origNode.listChildren()) {
            await extractAtDepth(logger, origDoc, origSceneIdx, child, nextDepth, targetDepth, discardDepthSplitParentNodes, docTransformerCallback, instanceCallback, takenNames, splitNodeIdxs, resetPosition, resetRotation, resetScale);
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
        // deduplicate document so that duplicate child detection doesn't fail
        await origDoc.transform(
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
                await extractAtDepth(logger, origDoc, s, child, 1, splitDepth, discardDepthSplitParentNodes, docTransformerCallback, instanceCallback, takenNames, splitNodeIdxs, resetPosition, resetRotation, resetScale);
            }
        }
    }
}