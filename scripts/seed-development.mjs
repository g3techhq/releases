#!/usr/bin/env node
// Prepare a development feed from the existing legacy dev feed. No Git writes
// or publication; review and commit the generated JSON normally.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSemver } from './publish-local.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const entry of fs.readdirSync(path.join(root, 'apps'), { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
  const legacy = path.join(root, 'apps', entry.name, 'latest.json');
  if (!fs.existsSync(legacy)) continue;
  let data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  if (process.argv.includes('--live')) {
    const response = await fetch(`https://raw.githubusercontent.com/g3techhq/releases/main/apps/${entry.name}/latest.json`, { signal: AbortSignal.timeout(15000), credentials: 'omit' });
    if (!response.ok) throw new Error(`${entry.name}: HTTP ${response.status}`);
    data = await response.json();
  }
  if (!data.platforms || Object.values(data.platforms).some(value => !value.signature || !value.url.startsWith(`https://github.com/g3techhq/releases/releases/download/${entry.name}-v`))) throw new Error(`${entry.name}: not a signed direct-development feed`);
  const destination = path.join(root, 'apps', entry.name, 'development.json');
  if (fs.existsSync(destination) && compareSemver(JSON.parse(fs.readFileSync(destination, 'utf8')).version, data.version) > 0) throw new Error(`${entry.name}: refusing a development-feed downgrade`);
  fs.writeFileSync(destination, JSON.stringify(data, null, 2) + '\n');
  console.log(`${entry.name}: development ${data.version}`);
}
