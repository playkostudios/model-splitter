# model-splitter

Splits a model into multiple models with different LOD levels and downscales
textures.

Usage:
`model-splitter <input file> <output folder> [--texture-size <percentage or target side length>] <lod 1 simplification ratio> <lod 2 simplification ratio> ...`

Example usage:
`model-splitter model.glb output 0.9 0.75 0.5 0.25 0.125 --texture-size 25%`

Note that there is always a LOD0 with a simplification ratio of 1 (no
simplification). This behaviour can be skipped by using model-splitter as a
library instead of as a CLI tool.

Note also that, since this is a node.js CLI tool, you may need to use
`npx model-splitter (...)`, instead of just `model-splitter (...)`. If running from
the source code folder, you need to use `node . (...)` since you don't have the
tool installed as a dependency.

## Example

There is a WLE example project in the `example-project` folder. It uses a given
LOD level and a metadata file, however, the model files aren't generated yet.
Use `model-splitter` with one of your model files before running the project,
with the output to the project's `static` folder. LOD level and metadata file
URL can be specified in the `model-loader` component in the editor.
