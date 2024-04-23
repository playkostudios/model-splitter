import { writeFileSync } from 'fs';
import { quat, vec3 } from 'gl-matrix';
import { type Metadata, type InstanceGroup } from './output-types';

const ZERO_VEC3: vec3 = [0, 0, 0];
const ONE_VEC3: vec3 = [1, 1, 1];
const ROT_IDENT: quat = [0, 0, 0, 1];
const TEMP_VEC3: vec3 = new Float32Array(3);

type ExtentBounds = [x: number, y: number, z: number];

interface RP1PhysicalBlueprint_V1 {
    blueprintType: 'physical',
    resourceReference?: string,
    pos?: [x: number, y: number, z: number],
    rot?: [x: number, y: number, z: number, w: number],
    scale?: [x: number, y: number, z: number],
    objectBounds: ExtentBounds,
    maxBounds: ExtentBounds,
    children?: RP1PhysicalBlueprint_V1[],
}

function transformTempVec3(blueprint: RP1PhysicalBlueprint_V1) {
    if (blueprint.rot) {
        vec3.transformQuat(TEMP_VEC3, TEMP_VEC3, blueprint.rot);
    }

    if (blueprint.scale) {
        vec3.mul(TEMP_VEC3, TEMP_VEC3, blueprint.scale);
    }

    if (blueprint.pos) {
        vec3.add(TEMP_VEC3, TEMP_VEC3, blueprint.pos);
    }
}

function fitTempVec3InMaxBounds(blueprint: RP1PhysicalBlueprint_V1) {
    const maxBounds = blueprint.maxBounds;
    maxBounds[0] = Math.max(maxBounds[0], Math.abs(TEMP_VEC3[0]));
    maxBounds[1] = Math.max(maxBounds[1], Math.abs(TEMP_VEC3[1]));
    maxBounds[2] = Math.max(maxBounds[2], Math.abs(TEMP_VEC3[2]));
}

function fitChildCornerInMaxBounds(child: RP1PhysicalBlueprint_V1, parent: RP1PhysicalBlueprint_V1, posX: boolean, posY: boolean, posZ: boolean) {
    TEMP_VEC3[0] = posX ? child.maxBounds[0] : -child.maxBounds[0];
    TEMP_VEC3[1] = posY ? child.maxBounds[1] : -child.maxBounds[1];
    TEMP_VEC3[2] = posZ ? child.maxBounds[2] : -child.maxBounds[2];
    transformTempVec3(child);
    fitTempVec3InMaxBounds(parent);
}

function expandMaxBounds(blueprint: RP1PhysicalBlueprint_V1) {
    if (!blueprint.children) {
        return;
    }

    for (const child of blueprint.children) {
        expandMaxBounds(child);

        if (vec3.exactEquals(child.maxBounds, ZERO_VEC3)) {
            // fast-path: child is a point, not a box
            vec3.zero(TEMP_VEC3);
            transformTempVec3(child);
            fitTempVec3InMaxBounds(blueprint);
        } else {
            // fit every corner of child in bounds
            fitChildCornerInMaxBounds(child, blueprint, false, false, false);
            fitChildCornerInMaxBounds(child, blueprint, false, false,  true);
            fitChildCornerInMaxBounds(child, blueprint, false,  true, false);
            fitChildCornerInMaxBounds(child, blueprint, false,  true,  true);
            fitChildCornerInMaxBounds(child, blueprint,  true, false, false);
            fitChildCornerInMaxBounds(child, blueprint,  true, false,  true);
            fitChildCornerInMaxBounds(child, blueprint,  true,  true, false);
            fitChildCornerInMaxBounds(child, blueprint,  true,  true,  true);
        }
    }
}

export function writeInstanceGroup_RP1Blueprint_V1(outPath: string, instanceGroup: InstanceGroup, sourceMetadata: Array<Metadata>): void {
    const rootBlueprint: RP1PhysicalBlueprint_V1 = {
        blueprintType: 'physical',
        objectBounds: [0, 0, 0],
        maxBounds: [0, 0, 0],
    };

    // build blueprint tree
    {
        const blueprints: RP1PhysicalBlueprint_V1[] = [rootBlueprint];

        const instances = instanceGroup.instances;
        const sources = instanceGroup.sources;
        const iCount = instances.length;
        for (let i = 0; i < iCount; i++) {
            const inst = instances[i];
            const p = inst.parent === undefined ? 0 : (inst.parent + 1);

            let objectBounds: ExtentBounds;
            let maxBounds: ExtentBounds;
            let resourceReference: string | undefined;

            if (inst.source !== undefined) {
                const source = sourceMetadata[inst.source];
                const sBounds = source.bounds;
                const maxX = Math.max(Math.abs(sBounds[0]), Math.abs(sBounds[3]));
                const maxY = Math.max(Math.abs(sBounds[1]), Math.abs(sBounds[4]));
                const maxZ = Math.max(Math.abs(sBounds[2]), Math.abs(sBounds[5]));
                objectBounds = [maxX, maxY, maxZ];
                maxBounds = [maxX, maxY, maxZ];
                resourceReference = sources[inst.source];
            } else {
                objectBounds = [0, 0, 0];
                maxBounds = [0, 0, 0];
            }

            const blueprint: RP1PhysicalBlueprint_V1 = {
                blueprintType: 'physical', objectBounds, maxBounds,
            };

            if (resourceReference) {
                blueprint.resourceReference = resourceReference;
            }

            if (!vec3.exactEquals(inst.position, ZERO_VEC3)) {
                blueprint.pos = [inst.position[0], inst.position[1], inst.position[2]];
            }

            if (!quat.exactEquals(inst.rotation, ROT_IDENT)) {
                blueprint.rot = [inst.rotation[0], inst.rotation[1], inst.rotation[2], inst.rotation[3]];
            }

            if (!vec3.exactEquals(inst.scale, ONE_VEC3)) {
                blueprint.scale = [inst.scale[0], inst.scale[1], inst.scale[2]];
            }

            const parent = blueprints[p];
            if (!parent.children) {
                parent.children = [];
            }

            parent.children.push(blueprint);
            blueprints.push(blueprint);
        }
    }

    // expand maxBounds according to descendant nodes
    expandMaxBounds(rootBlueprint);

    // write to file
    writeFileSync(outPath, JSON.stringify(rootBlueprint));
}