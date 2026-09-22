const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const raiz = path.resolve(__dirname, '..');
const pacote = require('../package.json');
const lock = require('../package-lock.json');

test('runtime: manifesto e lockfile exigem Node 24', () => {
  assert.equal(pacote.engines?.node, '24');
  assert.equal(lock.packages?.['']?.engines?.node, '24');
});

test('runtime: SDKs principais carregam no Node 24', () => {
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  assert.doesNotThrow(() => require('firebase-admin/app'));
  assert.doesNotThrow(() => require('firebase-functions/v2'));
});

test('runtime: Firebase CLI homologada reconhece nodejs24 como GA', () => {
  const { getRuntimeChoice } = require('firebase-tools/lib/deploy/functions/runtimes/node/parseRuntimeAndValidateSDK.js');
  const { RUNTIMES } = require('firebase-tools/lib/deploy/functions/runtimes/supported/types.js');
  const runtime = getRuntimeChoice(raiz);
  assert.equal(runtime, 'nodejs24');
  assert.equal(RUNTIMES[runtime]?.status, 'GA');
});

test('runtime: binário FFmpeg da plataforma está presente e executa', () => {
  const ffmpeg = require('@ffmpeg-installer/ffmpeg');
  assert.equal(typeof ffmpeg.path, 'string');
  assert.equal(fs.existsSync(ffmpeg.path), true);
  const resultado = spawnSync(ffmpeg.path, ['-version'], {
    cwd: raiz,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(resultado.error, undefined);
  assert.equal(resultado.status, 0);
  assert.match(resultado.stdout, /^ffmpeg version /i);
});
