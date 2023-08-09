# model-splitter

Splits a model into multiple models with different LOD levels and downscales
textures. Textures can be embedded in the model, or stored separately alongside
a metadata JSON file, which needs to be parsed with a custom parser.

There is no support for Draco mesh compression. There is support for KTX2
texture compression, however:
- It is transcoded to an uncompressed format at runtime, so all GPU memory benefits are lost
- The textures can't be embedded, otherwise Wonderland Engine's GLB texture loader is used and the runtime crashes, since the GLB loader doesn't support KTX2

This is only meant to be used with Wonderland Engine, and with a custom loader.
A lot of the features that exist in this tool are to address current limitations
in the engine. Do not expect support for other engines. For other engines it's
much better to just use `gltfpack` separately for each LOD, which will also give
you Draco compression.

There are 2 versions of the tool:
- CLI: run the tool from the terminal. Useful for automating LOD generation in scripts
- GUI: run the tool from a graphical user interface. Useful if you want to generate LODs for a small amount of models manually, or don't like CLI

The tool can also be included as a library.

## Installing the tool

All installation methods require
[gltfpack](https://github.com/zeux/meshoptimizer#installing-gltfpack) to be
installed. Since there is no standard installation path, the tool assumes that
gltfpack is globally accessible as the `gltfpack` binary (or `gltfpack.exe` on
Windows). A path to the binary can also be supplied to the library, CLI and GUI.

[GraphicsMagick](http://www.graphicsmagick.org/) must also be installed for
texture resizing to work, except if resizing textures with Basis Universal.

### Build from source

1. Make sure [Node.js](https://nodejs.org/en) is installed
2. Make sure [pnpm](https://pnpm.io/) is installed. If you are using corepack, you will get an error when attempting to use any other package manager
3. Run `pnpm install`
4. Run `pnpm run build-all`

If you wish to create a package with this tool, run `pnpm run pkg-all`, or
`pnpm run build-pkg-all` if you want to build and then package.

### Pre-compiled binaries

If you are on Linux or Windows, you can download the CLI or GUI binary from the
[releases tab](https://github.com/playkostudios/model-splitter/releases/). For
example, if you want to use the GUI version on Windows, extract the zip
(`model-splitter-gui-win.zip`) and run `model-splitter-gui.exe`.

If you only want to use this as a library, the `model-splitter-X.X.X.tgz`
package can be used as a regular node package with
`npm install --save-dev model-splitter-X.X.X.tgz`.

## CLI

<!-- usage-beg -->

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
- `<lod simplification ratio>[:<texture percentage or target side length>][:optimize-scene-hierarchy][:keep-scene-hierarchy][:merge-materials][:no-material-merging][:aggressive][:not-aggressive][:uastc][:etc1s][:no-basisu]`: Adds an LOD to be generated. The simplification ratio determines how much to simplify the model; 1 is no simplification, 0.5 is 50% simplification. The texture, scene hierarchy, and material options are equivalent to (or counteract), respectively, "--texture-size", "--keep-scene-hierarchy", "--no-material-merging", "--aggressive" and "--basisu" but only apply to this LOD
- `--force`: Replace existing files. This flag is not set by default, meaning that if a file needs to be replaced the tool will throw an error
- `--embed-textures`: Force each LOD model to have embedded textures instead of external textures
- `--keep-scene-hierarchy`: Don't optimize the scene hierarchy; keeps the same hierarchy instead of merging nodes, at the expense of higher draw calls. Can be overridden per LOD
- `--no-material-merging`: Don't merge materials and keep material names. Can be overridden per LOD
- `--aggressive`: Simplify mesh disregarding quality. Can be overridden per LOD
- `--texture-size <percentage or target side length>`: The texture size to use for each generated LOD if it's not specified in the LOD arguments
- `--basisu <disabled, uastc, etc1s>`: Should textures be compressed with basisu? Can be overridden per LOD. Disabled by default
- `--split-depth <depth>`: If set to an integer greater than 0, then the model will be split into multiple ones at the child nodes at the given depth. For example, a depth of 1 indicates children, 2 grandchildren, etc... A split depth of 1 would create multiple model files per LOD with each child of the root, instead of a single model file per LOD with the root of the scene
- `--reset-position`: Reset position of root node, or each child node if splitting by depth
- `--reset-rotation`: Reset rotation of root node, or each child node if splitting by depth
- `--reset-scale`: Reset scale of root node, or each child node if splitting by depth
- `--create-instance-group`: Create a separate instance group metadata file. This is especially useful for depth-split models which reset child transforms, as this file will contain a scene with references to all the split models, and their placements in the scene
- `--discard-depth-split-parent-nodes`: If enabled, parent nodes above the target split depth will be discarded. For example, if splitting at a depth of 3, nodes at a depth of 1 and 2 will be discarded
- `--gltfpack-path <gltfpack bin path>`: Path to gltfpack binary. If none is specified, then the binary is assumed to be accessible via the PATH variable ("gltfpack" on Linux, "gltfpack.exe" on Windows)
- `--log-level <log level>`: The log level to use. Can be: 'none', 'error', 'warning', 'log' or 'debug'
- `--version`: Print version and exit
- `--help`: Print help and exit

If an option that can only be specified once is supplied multiple times, then only the last value is used.

<!-- usage-end -->

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

If KTX2 support is needed, the Basis Universal transcoder also needs to be
included in your bundle's folder. This can be automated by copying the
transcoder files from the `node_modules/model-splitter/lib-static` folder to the
`deploy` folder in your build script, or in your prepare script by copying to
the `static` folder instead of the `deploy` folder.

## Example

There is a WLE example project in the `example-project` folder. It uses a given
LOD level and a metadata file, however, the model files aren't generated yet.
Use `model-splitter` with one of your model files before running the project,
with the output to the project's `static` folder. LOD level and metadata file
URL can be specified in the `model-loader` component in the editor.

## License

This project is licensed under the MIT license (see the LICENSE file)

This project uses the following open-source projects:
- [@ffflorian/jszip-cli](https://github.com/ffflorian/node-packages/tree/main) licensed under the GPL 3.0 license
- [@typescript-eslint/eslint-plugin](https://github.com/typescript-eslint/typescript-eslint) licensed under the MIT license
- [@typescript-eslint/parser](https://github.com/typescript-eslint/typescript-eslint) licensed under the BSD 2-Clause license
- [@wonderlandengine/api](https://www.npmjs.com/package/@wonderlandengine/api) licensed under the MIT license
- [@wonderlandengine/components](https://www.npmjs.com/package/@wonderlandengine/components) licensed under the MIT license
- [async-mutex](https://github.com/DirtyHairy/async-mutex#readme) licensed under the MIT license
- The [Basis Universal](https://github.com/BinomialLLC/basis_universal/tree/master/webgl) WebAssembly transcoder and loader (modified) licensed under the Apache 2.0 license
- [colors](https://github.com/Marak/colors.js) licensed under the MIT license
- [concurrently](https://github.com/open-cli-tools/concurrently#readme) licensed under the MIT license
- [draco3dgltf](https://github.com/google/draco#readme) licensed under the Apache 2.0 license
- [DefinitelyTyped](http://definitelytyped.github.io/) licensed under the MIT license
- [esbuild](https://github.com/evanw/esbuild) licensed under the MIT license
- [eslint](https://github.com/eslint/eslint) licensed under the MIT license
- [glTF-Transform](https://gltf-transform.donmccurdy.com/) licensed under the MIT license
- [gltfpack](https://github.com/zeux/meshoptimizer) licensed under the MIT license
- [gm](https://github.com/aheckmann/gm#readme) licensed under the MIT license
- [mikktspace](https://github.com/donmccurdy/mikktspace-wasm#readme) licensed under the MIT license
- [node-notifier](https://github.com/mikaelbr/node-notifier#readme) licensed under the MIT license
- [nw-builder](https://github.com/nwutils/nw-builder) licensed under the MIT license
- [pkg](https://github.com/vercel/pkg#readme) licensed under the MIT license
- [shx](https://github.com/shelljs/shx#readme) licensed under the MIT license
- [tar](https://github.com/npm/node-tar#readme) licensed under the ISC license
- [typescript](https://github.com/Microsoft/TypeScript) licensed under the Apache 2.0 license