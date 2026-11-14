// Read-only validation before CI signs or publishes any release assets.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './release-manifest.mjs';
import { checkNewer, newerRelease, verifyProductionApk } from './publish-local.mjs';

const lines = text => (text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const pair = line => {
  const index = line.indexOf('=');
  if (index < 1) throw new Error(`Expected platform=value: ${line}`);
  return [line.slice(0, index), line.slice(index + 1)];
};

export function preflightManifest(env, current) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(env.APP)) throw new Error('Invalid app');
  if (!['development', 'beta', 'production'].includes(env.CHANNEL)) throw new Error('Invalid channel');
  checkNewer(env.VERSION, current);
  const downloads = lines(env.FILES).map(line => {
    const [platform, fileName] = pair(line);
    return { platform, fileName, signature: 'untrusted comment: preflight only' };
  });
  const stores = lines(env.STORES).map(line => {
    const [platform, url] = pair(line);
    return { platform, url };
  });
  const manifest = buildManifest({ version: env.VERSION, downloads, stores,
    baseUrl: `https://github.com/g3techhq/releases/releases/download/${env.APP}-v${env.VERSION}` });
  const missing = Object.keys(current?.platforms ?? {}).filter(platform => !manifest.platforms[platform]);
  if (missing.length) throw new Error(`Release would drop existing platforms: ${missing.join(', ')}. Publish all targets or split their feeds first.`);
  for (const name of [...downloads.map(file => file.fileName), ...lines(env.ATTACH)]) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid asset filename: ${name}`);
  }
  return downloads.map(file => file.fileName).concat(lines(env.ATTACH));
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = channel => {
    const file = path.join(root, 'apps', process.env.APP, `${channel}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(process.env.APP ?? '')) throw new Error('Invalid app');
  if (!['development', 'beta', 'production'].includes(process.env.CHANNEL)) throw new Error('Invalid channel');
  const current = newerRelease(read(process.env.CHANNEL), process.env.CHANNEL === 'development' ? read('latest') : undefined);
  for (const name of preflightManifest(process.env, current)) {
    const file = path.resolve('dist', name);
    if (!existsSync(file)) throw new Error(`Missing release asset: ${name}`);
    if (process.env.CHANNEL === 'production' && name.toLowerCase().endsWith('.apk')) verifyProductionApk(file);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
