/**
 * Fails if the Playwright dependency version in package.json is out of sync
 * with the mcr.microsoft.com/playwright image tag and the `playwright@x.y.z`
 * run-server command in docker-compose.yml. A mismatch causes connection
 * failures between the API and the browser server at runtime.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const depRange = pkg.dependencies?.playwright ?? '';
const depVersion = depRange.replace(/^[^\d]*/, '');

const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
const imageMatch = compose.match(
  /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)/,
);
const commandMatch = compose.match(/playwright@(\d+\.\d+\.\d+)/);

const problems = [];
if (!depVersion) problems.push('package.json is missing a playwright version');
if (!imageMatch) problems.push('docker-compose.yml has no playwright image tag');
if (!commandMatch) problems.push('docker-compose.yml has no playwright@x.y.z command');

const imageVersion = imageMatch?.[1];
const commandVersion = commandMatch?.[1];

if (imageVersion && imageVersion !== depVersion) {
  problems.push(
    `image tag v${imageVersion} != package.json playwright ${depVersion}`,
  );
}
if (commandVersion && commandVersion !== depVersion) {
  problems.push(
    `run-server command ${commandVersion} != package.json playwright ${depVersion}`,
  );
}

if (problems.length > 0) {
  console.error('Playwright version mismatch:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`Playwright versions are in sync at ${depVersion}.`);
