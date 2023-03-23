const { readdirSync } = require('node:fs');
const { create: createTar } = require('tar');

if (process.argv.length !== 3) {
    throw new Error(`Expected 1 argument, got ${Math.max(process.argv.length - 2, 0)}`);
}

createTar(
    {
        gzip: true,
        file: process.argv[2]
    },
    readdirSync(process.cwd())
);