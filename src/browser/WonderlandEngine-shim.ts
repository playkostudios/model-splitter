import type { Scene, Texture } from '@wonderlandengine/api';

export interface WonderlandEngine {
    scene: Scene,
    Texture: typeof Texture,
}