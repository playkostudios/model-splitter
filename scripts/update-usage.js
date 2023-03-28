const { readFileSync, writeFileSync } = require('fs');
const { getUsageString } = require('../src/base/getUsageString');

// update usage in readme.md
const readme = readFileSync('README.md', { encoding: 'utf8' });

const markBeg = '<!-- usage-beg -->';
const iBeg = readme.indexOf(markBeg);
if (iBeg < 0) {
    throw new Error(`Couldn't find beginning marker "${markBeg}"`);
}

const markEnd = '<!-- usage-end -->';
const iEnd = readme.indexOf(markEnd);
if (iEnd < 0) {
    throw new Error(`Couldn't find end marker "${markBeg}"`);
}

const readmeOut = `${readme.slice(0, iBeg + markBeg.length)}\n\n${getUsageString('model-splitter', '"gltfpack" on Linux, "gltfpack.exe" on Windows', (str) => `\`\`\`\n${str}\n\`\`\``, (str) => `\`${str}\``)}\n\n${readme.slice(iEnd)}`;
writeFileSync('README.md', readmeOut)