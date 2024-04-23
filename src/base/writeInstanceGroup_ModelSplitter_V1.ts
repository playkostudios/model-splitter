import { writeFileSync } from 'fs';
import { type InstanceGroup } from './output-types';

export function writeInstanceGroup_ModelSplitter_V1(outPath: string, instanceGroup: InstanceGroup): void {
    writeFileSync(outPath, JSON.stringify(instanceGroup));
}