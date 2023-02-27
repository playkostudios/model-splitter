# model-splitter

Splits a model into multiple models with different LOD levels and downscales
textures.

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

Options:
- `<input file>`: The model file to split into LODs
- `<output folder>`: The folder to put the split model into
- `--embed-textures`: Force each LOD model to have embedded textures instead of external textures
- `--texture-size <percentage or target side length>`: The texture size to use for each generated LOD if it's not specified in the LOD arguments
- `<lod simplification ratio>[:<texture percentage or target side length>]`: Adds an LOD to be generated. The simplification ratio determines how much to simplify the model; 1 is no simplification, 0.5 is 50% simplification. The texture option is equivalent to "--texture-size" but only applies to this LOD

Note that, since this is a node.js CLI tool, you may need to use
`npx model-splitter (...)`, instead of just `model-splitter (...)`. If running
from the source code folder, you need to use `node . (...)` since you don't have
the tool installed as a dependency.

## Example

There is a WLE example project in the `example-project` folder. It uses a given
LOD level and a metadata file, however, the model files aren't generated yet.
Use `model-splitter` with one of your model files before running the project,
with the output to the project's `static` folder. LOD level and metadata file
URL can be specified in the `model-loader` component in the editor.
