# model-splitter

Splits a model into multiple models with different LOD levels and downscales
textures. Textures can be embedded in the model, or stored separately alongside
a metadata JSON file, which needs to be parsed with a custom parser.

This is only meant to be used with Wonderland Engine, and with a custom loader.
A lot of the features that exist in this tool are to address current limitations
in the engine. Do not expect support for other engines. For other engines it's
much better to just use `gltfpack` separately for each LOD, which will also give
you Draco and KTX2 compression.

There are 2 versions of the tool:
- CLI: run the tool from the terminal. Useful for automating LOD generation in scripts
- GUI: run the tool from a graphical user interface. Useful if you want to generate LODs for a small amount of models manually, or don't like CLI

The tool can also be included as a library.

## CLI

Usage:
```
model-splitter <input file> <output folder> [--embed-textures] [--texture-size <percentage or target side length>] <lod 1 simplification ratio>[:<texture percentage or target side length>] <lod 2 simplification ratio>[:<texture percentage or target side length>] ...
```

Example usage:
- Split a model named "model.glb" into the folder "output" with 6 LOD levels (100%, 90%, 75%, 50%, 25%, and 12.5% mesh kept) and a texture size of 25%
```
model-splitter model.glb output 1 0.9 0.75 0.5 0.25 0.125 --texture-size 25%
```
- Split a model named "model.glb" into the folder "output" with 4 LOD levels (100%, 75%, 50%, and 25% mesh kept) and a texture size of 100%, 50%, 25% and 12.5% respectively
```
model-splitter model.glb output 1 0.75:50% 0.5:25% 0.25:12.5%
```
- Split a model named "model.glb" into the folder "output" with 4 LOD levels (100%, 75%, 50%, and 25% mesh kept), a texture size of 100%, 50%, 25% and 12.5% respectively, and keep the scene hierarchy, except for the lowest LOD
```
model-splitter model.glb output 1 0.75:50% 0.5:25% 0.25:12.5%:optimize-scene-hierarchy --keep-scene-hierarchy
```

Options:
- `<input file>`: The model file to split into LODs
- `<output folder>`: The folder to put the split model into
- `<lod simplification ratio>[:<texture percentage or target side length>][:optimize-scene-hierarchy][:keep-scene-hierarchy][:merge-materials][:no-material-merging]`: Adds an LOD to be generated. The simplification ratio determines how much to simplify the model; 1 is no simplification, 0.5 is 50% simplification. The texture, scene hierarchy, and material options are equivalent to (or counteract), respectively, "--texture-size", "--keep-scene-hierarchy" and "no-material-merging" but only apply to this LOD
- `--force`: Replace existing files. This flag is not set by default, meaning that if a file needs to be replaced the tool will throw an error
- `--embed-textures`: Force each LOD model to have embedded textures instead of external textures
- `--keep-scene-hierarchy`: Don't optimize the scene hierarchy; keeps the same hierarchy instead of merging nodes, at the expense of higher draw calls. Can be overridden per LOD
- `--no-material-merging`: Don't merge materials and keep material names. Can be overridden per LOD
- `--texture-size <percentage or target side length>`: The texture size to use for each generated LOD if it's not specified in the LOD arguments
- `--version`: Print version and exit
- `--help`: Print help and exit

Note that, since this is a node.js CLI tool, you may need to use
`npx model-splitter (...)`, instead of just `model-splitter (...)`. If running
from the source code folder, you need to use `node . (...)` since you don't have
the tool installed as a dependency.

## GUI

There is a graphical user interface available, built with NW.js. This is not
recommended, as the CLI version is much lighter, but you can find pre-built
binaries in the releases tab if you prefer it.

## Library

This tool can also be used as a library when imported as a module. Simply import
the `splitModel` function and call it:

```
type ConcreteResizeOption = [width: number, height: number, type?: ResizeOption];
type PackedResizeOption = ConcreteResizeOption | 'keep';
type DefaultablePackedResizeOption = PackedResizeOption | 'default';
type LODConfigList = Array<[ meshLODRatio: number, textureResizeOpt: DefaultablePackedResizeOption, keepSceneHierarchy?: boolean | null, noMaterialMerging?: boolean | null ]>;

interface SplitModelOptions {
    embedTextures?: boolean;
    defaultResizeOpt?: PackedResizeOption;
    defaultKeepSceneHierarchy?: boolean;
    defaultNoMaterialMerging?: boolean;
    force?: boolean;
    logger?: Logger;
}

splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options?: SplitModelOptions);
```

- `inputModelPath`: The model file to split into LODs
- `outputFolder`: The folder to put the split model into
- `lods`: A list of LODs to generate, where each element in the array is a list of options to use for the LOD
- `options`: An optional object containing additional options which aren't specific to a LOD

## Runtime library

A Wonderland Engine runtime library is also available for loading models from
metadata JSON files. Import it by doing:

```
import { LODModelLoader } from 'model-splitter/runtime-lib.esm';
```

Check the `LODModelLoader` class for usage, or the example in the
`example-project` folder.

## Example

There is a WLE example project in the `example-project` folder. It uses a given
LOD level and a metadata file, however, the model files aren't generated yet.
Use `model-splitter` with one of your model files before running the project,
with the output to the project's `static` folder. LOD level and metadata file
URL can be specified in the `model-loader` component in the editor.

## Installing on Windows

Download a windows binary from the
[releases tab](https://github.com/playkostudios/model-splitter/releases/). If
using the GUI version, extract the zip (`model-splitter-gui-win.zip`) and run
`model-splitter-gui.exe`.

## License

This project is licensed under the MIT license (see the LICENSE file)

This project uses the following open-source projects:
- [@ffflorian/jszip-cli](https://github.com/ffflorian/node-packages/tree/main) licensed under the GPL 3.0 license
- [@typescript-eslint/eslint-plugin](https://github.com/typescript-eslint/typescript-eslint) licensed under the MIT license
- [@typescript-eslint/parser](https://github.com/typescript-eslint/typescript-eslint) licensed under the BSD 2-Clause license
- [@wonderlandengine/api](https://www.npmjs.com/package/@wonderlandengine/api) licensed under the MIT license
- [@wonderlandengine/components](https://www.npmjs.com/package/@wonderlandengine/components) licensed under the MIT license
- [babylonjs-gltf2interface](https://www.babylonjs.com/) licensed under the Apache 2.0 license
- [cesium](http://cesium.com/cesiumjs/) licensed under the Apache 2.0 license
- [colors](https://github.com/Marak/colors.js) licensed under the MIT license
- [concurrently](https://github.com/open-cli-tools/concurrently#readme) licensed under the MIT license
- [data-uri-to-buffer](https://github.com/TooTallNate/node-data-uri-to-buffer) licensed under the MIT license
- [draco3dgltf](https://github.com/google/draco#readme) licensed under the Apache 2.0 license
- [DefinitelyTyped](http://definitelytyped.github.io/) licensed under the MIT license
- [esbuild](https://github.com/evanw/esbuild) licensed under the MIT license
- [eslint](https://github.com/eslint/eslint) licensed under the MIT license
- [glob](https://github.com/isaacs/node-glob#readme) licensed under the ISC license
- [gltf-pipeline](https://github.com/CesiumGS/gltf-pipeline) licensed under the Apache 2.0 license
- [glTF-Transform](https://gltf-transform.donmccurdy.com/) licensed under the MIT license
- [gltfpack](https://github.com/zeux/meshoptimizer) licensed under the MIT license
- [node-notifier](https://github.com/mikaelbr/node-notifier#readme) licensed under the MIT license
- [nw-builder](https://github.com/nwutils/nw-builder) licensed under the MIT license
- [pkg](https://github.com/vercel/pkg#readme) licensed under the MIT license
- [sharp](https://github.com/lovell/sharp) licensed under the Apache 2.0 license
- [shx](https://github.com/shelljs/shx#readme) licensed under the MIT license
- [typescript](https://github.com/Microsoft/TypeScript) licensed under the Apache 2.0 license