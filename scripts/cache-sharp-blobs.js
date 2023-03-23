const { resolve: resolvePath, basename } = require('node:path');
const { copyFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } = require('node:fs');
const { get: httpGet } = require('node:https');
const decompress = require('decompress');

const { devDependencies } = require('../package.json');

function httpGetFollow(url) {
    return new Promise((resolve, reject) => {
        httpGet(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                httpGetFollow(response.headers.location).then(resolve).catch(reject);
            } else if (response.statusCode !== 200) {
                reject(new Error(`Unexpected status code: ${response.statusCode}`));
                return;
            } else {
                resolve(response);
            }
        }).on('error', reject);
    });
}

function pipeResponseToBuffer(response) {
    console.info('getting response body');
    return new Promise((resolve, reject) => {
        const buffers = [];
        response.on('readable', () => {
            let buffer;
            while ((buffer = response.read()) !== null) {
                buffers.push(buffer);
            }
        });
        response.on('end', () => resolve(Buffer.concat(buffers)));
        response.on('error', reject);
    });
}

async function download(url, expectedFilename, outFolder) {
    console.info(`downloading "${url}"`);
    const response = await httpGetFollow(url);
    try {
        const tgzBuffer = await pipeResponseToBuffer(response);
        console.info('decompressing response');
        const files = await decompress(tgzBuffer);

        let found = false;
        for (const file of files) {
            if (basename(file.path) === expectedFilename) {
                found = true;
                break;
            }
        }

        if (!found) {
            throw new Error(`Expected a "${expectedFilename}" file in tar.gz, but file was missing`);
        }

        for (const file of files) {
            const outPath = resolvePath(outFolder, basename(file.path));
            console.info(`extracting file to "${outPath}"`);
            writeFileSync(outPath, files[0].data);
        }

        console.info('done extracting files');
    } finally {
        response.destroy();
    }
}

async function cacheTargetPlatform(targetPlatform, sharpTargetVersion) {
    // check if already downloaded
    const targetFilename = `sharp-${targetPlatform}.node`;
    const outFolder = resolvePath(__dirname, '..', 'sharp-cache');
    const outPath = resolvePath(outFolder, targetFilename);

    if (existsSync(outPath)) {
        console.info(`sharp target platform "${targetPlatform}" already cached`);
        return;
    }

    // use local build from node_modules if available
    const nodeInPath = resolvePath(__dirname, '..', 'node_modules', 'sharp', 'build', 'Release', targetFilename);

    if (existsSync(nodeInPath)) {
        copyFileSync(nodeInPath, outPath);

        // try to copy vendor libs too
        const vendorFolder = resolvePath(__dirname, '..', 'node_modules', 'sharp', 'vendor');
        try {
            const verFolderName = readdirSync(vendorFolder)[0];
            const platVendorFolderPath = resolvePath(__dirname, '..', 'node_modules', 'sharp', 'vendor', verFolderName, targetPlatform, 'lib');
            const platVendorFolder = readdirSync(platVendorFolderPath);

            for (const file of platVendorFolder) {
                const inPath = resolvePath(__dirname, '..', 'node_modules', 'sharp', 'vendor', verFolderName, targetPlatform, 'lib', file);
                if (statSync(inPath).isFile()) {
                    copyFileSync(inPath, resolvePath(outFolder, basename(inPath)));
                }
            }
        } catch(err) {
            console.warn(err);
        }
        console.info(`sharp target platform "${targetPlatform}" copied from node_modules`);
        return;
    }

    // download if not available in node_modules
    const remoteInURL = `https://github.com/lovell/sharp/releases/download/v${sharpTargetVersion}/sharp-v${sharpTargetVersion}-napi-v7-${targetPlatform}.tar.gz`;
    await download(remoteInURL, targetFilename, outFolder);
    console.info(`sharp target platform "${targetPlatform}" downloaded`);
}

async function main() {
    // create sharp-cache folder
    const outDir = resolvePath(__dirname, '..', 'sharp-cache');
    if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
    }

    // get target version to download
    const sharpTargetVersion = devDependencies.sharp;

    if (sharpTargetVersion === undefined) {
        throw new Error('"sharp" is not a devDependency in package.json');
    }

    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(sharpTargetVersion)) {
        throw new Error('"sharp" devDependency must be targetting a specific version in the format X.X.X');
    }

    // cache for each platform
    const targetPlatforms = ['linux-x64', 'win32-x64'];

    const promises = [];
    for (const targetPlatform of targetPlatforms) {
        promises.push(cacheTargetPlatform(targetPlatform, sharpTargetVersion));
    }

    await Promise.all(promises);

    console.info('all done');
    // XXX for some reason the process hangs after doing a request, so we
    // force-quit
    process.exit(0);
}

main();
