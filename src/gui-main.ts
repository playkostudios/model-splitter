import { readFileSync } from 'node:fs';
import splitModel from './lib';
const gltfpack = require('gltfpack');

// XXX gltfpack is not auto-initialized because nw.js contexts are weird
gltfpack.init(readFileSync(__dirname + '/library.wasm'));

module.exports = splitModel;