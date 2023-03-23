const { build } = require('esbuild');
const textReplace = require('esbuild-plugin-text-replace');
const { resolve: resolvePath } = require('node:path');

const infile = resolvePath(__dirname, '..', 'src', 'worker', 'gui-worker.ts');
const outfile = resolvePath(__dirname, '..', 'nwjs-out', 'worker-bundle.js');
const watch = process.argv.indexOf('--watch') !== -1;

build({
    watch,
    minify: true,
    bundle: true,
    sourcemap: true,
    target: 'es6',
    platform: 'node',
    format: 'cjs',
    outfile,
    entryPoints: [infile],
    plugins: [
        textReplace({
            include: /\/node_modules\/sharp\/lib\/(libvips|sharp).js$/,
            pattern: [
                [/const\s+([a-zA-Z]+)\s+=\s+path\.join\(\s+__dirname,\s+['"`]\.\.['"`],\s+['"`]vendor['"`],\s+minimumLibvipsVersion,\s+platform\(\)\s+\)/g, (_match, varName) => `const ${varName} = path.join(__dirname, platform())`],
                [/require\(`\.\.\/build\/Release\/sharp-\${platformAndArch}\.node`\)/g, 'require(`sharp-${platformAndArch}.node`)']
            ]
        })
    ]
}).then(() => {
    if (!watch) {
        process.exit(0);
    }
}).catch((err) => {
    console.error(err);
    if (!watch) {
        process.exit(1);
    }
});