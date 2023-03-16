# model-splitter

Splits a model into multiple models with different LOD levels and downscales
textures. Textures can be embedded in the model, or stored separately alongside
a metadata JSON file, which needs to be parsed with a custom parser.

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

Note that GraphicsMagick needs to be installed if texture resizing is done. To
install GraphicsMagick, follow the instructions in the
[official website](http://www.graphicsmagick.org/download.html).
