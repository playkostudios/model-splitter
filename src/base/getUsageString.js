function getUsageString(execName, defaultGltfpackPath, decorateExec = null, decorateArg = null) {
    if (decorateExec === null) {
        decorateExec = (str) => str;
    }

    if (decorateArg === null) {
        decorateArg = (str) => str;
    }

    return `\
Usage:
${decorateExec(execName + ' <input file> <output folder> [--embed-textures] [--texture-size <percentage or target side length>] <lod 1 simplification ratio>[:<texture percentage or target side length>] <lod 2 simplification ratio>[:<texture percentage or target side length>] ...')}

Example usage:
- Split a model named "model.glb" into the folder "output" with 6 LOD levels (100%, 90%, 75%, 50%, 25%, and 12.5% mesh kept) and a texture size of 25%
${decorateExec(execName + ' model.glb output 1 0.9 0.75 0.5 0.25 0.125 --texture-size 25%')}
- Split a model named "model.glb" into the folder "output" with 4 LOD levels (100%, 75%, 50%, and 25% mesh kept) and a texture size of 100%, 50%, 25% and 12.5% respectively
${decorateExec(execName + ' model.glb output 1 0.75:50% 0.5:25% 0.25:12.5%')}
- Split a model named "model.glb" into the folder "output" with 4 LOD levels (100%, 75%, 50%, and 25% mesh kept), a texture size of 100%, 50%, 25% and 12.5% respectively, and keep the scene hierarchy, except for the lowest LOD
${decorateExec(execName + ' model.glb output 1 0.75:50% 0.5:25% 0.25:12.5%:optimize-scene-hierarchy --keep-scene-hierarchy')}

Options:
- ${decorateArg('<input file>')}: The model file to split into LODs
- ${decorateArg('<output folder>')}: The folder to put the split model into
- ${decorateArg('<lod simplification ratio>[:<texture percentage or target side length>][:optimize-scene-hierarchy][:keep-scene-hierarchy][:merge-materials][:no-material-merging][:aggressive][:not-aggressive][:uastc][:etc1s][:no-basisu]')}: Adds an LOD to be generated. The simplification ratio determines how much to simplify the model; 1 is no simplification, 0.5 is 50% simplification. The texture, scene hierarchy, and material options are equivalent to (or counteract), respectively, "--texture-size", "--keep-scene-hierarchy", "--no-material-merging", "--aggressive" and "--basisu" but only apply to this LOD
- ${decorateArg('--force')}: Replace existing files. This flag is not set by default, meaning that if a file needs to be replaced the tool will throw an error
- ${decorateArg('--embed-textures')}: Force each LOD model to have embedded textures instead of external textures
- ${decorateArg('--keep-scene-hierarchy')}: Don't optimize the scene hierarchy; keeps the same hierarchy instead of merging nodes, at the expense of higher draw calls. Can be overridden per LOD
- ${decorateArg('--no-material-merging')}: Don't merge materials and keep material names. Can be overridden per LOD
- ${decorateArg('--aggressive')}: Simplify mesh disregarding quality. Can be overridden per LOD
- ${decorateArg('--texture-size <percentage or target side length>')}: The texture size to use for each generated LOD if it's not specified in the LOD arguments
- ${decorateArg('--basisu <disabled, uastc, etc1s>')}: Should textures be compressed with basisu? Can be overridden per LOD. Disabled by default
- ${decorateArg('--split-depth <depth>')}: If set to an integer greater than 0, then the model will be split into multiple ones at the child nodes at the given depth. For example, a depth of 1 indicates children, 2 grandchildren, etc... A split depth of 1 would create multiple model files per LOD with each child of the root, instead of a single model file per LOD with the root of the scene
- ${decorateArg('--reset-position')}: Reset position of root node, or each child node if splitting by depth
- ${decorateArg('--reset-rotation')}: Reset rotation of root node, or each child node if splitting by depth
- ${decorateArg('--reset-scale')}: Reset scale of root node, or each child node if splitting by depth
- ${decorateArg('--gltfpack-path <gltfpack bin path>')}: Path to gltfpack binary. If none is specified, then the binary is assumed to be accessible via the PATH variable (${defaultGltfpackPath})
- ${decorateArg('--log-level <log level>')}: The log level to use. Can be: 'none', 'error', 'warning', 'log' or 'debug'
- ${decorateArg('--version')}: Print version and exit
- ${decorateArg('--help')}: Print help and exit

If an option that can only be specified once is supplied multiple times, then only the last value is used.`
}

module.exports = { getUsageString };