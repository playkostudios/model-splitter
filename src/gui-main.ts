// expose splitModel function
import splitModel from './lib';

// expose node-notifier's notify function
const { notify } = require('node-notifier');

// XXX gltfpack is not auto-initialized because nw.js contexts are weird
import { readFileSync } from 'node:fs';
const gltfpack = require('gltfpack');
gltfpack.init(readFileSync(__dirname + '/library.wasm'));

module.exports = { splitModel, notify };