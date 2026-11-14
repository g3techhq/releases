import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightManifest } from '../scripts/preflight-workflow.mjs';
const env = { APP: 'skicut', VERSION: '1.2.3', CHANNEL: 'development', FILES: 'android=SnowCut.apk\nwindows-x86_64-nsis=SnowCut-setup.zip', ATTACH: 'SnowCut-setup.exe' };
const current = { version: '1.2.2', platforms: { android: {}, 'windows-x86_64-nsis': {} } };
test('workflow accepts all current targets and returns every asset for verification', () => {
  assert.deepEqual(preflightManifest(env, current), ['SnowCut.apk', 'SnowCut-setup.zip', 'SnowCut-setup.exe']);
});
test('workflow refuses regression, partial releases, invalid channels and unsafe attachments', () => {
  assert.throws(() => preflightManifest({ ...env, VERSION: '1.2.2' }, current), /not newer/);
  assert.throws(() => preflightManifest({ ...env, FILES: 'windows-x86_64-nsis=SnowCut-setup.zip' }, current), /drop existing platforms: android/);
  assert.throws(() => preflightManifest({ ...env, CHANNEL: '../latest' }, current), /Invalid channel/);
  assert.throws(() => preflightManifest({ ...env, ATTACH: '../SnowCut.apk' }, current), /Invalid asset filename/);
});
