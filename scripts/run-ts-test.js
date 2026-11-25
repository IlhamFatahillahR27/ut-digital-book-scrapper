import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const targetScript = process.argv[2];
if (!targetScript) {
  console.error('Usage: node scripts/run-ts-test.js <path-to-ts-file> [args...]');
  process.exit(1);
}

const extraArgs = process.argv.slice(3);
const cacheDir = path.resolve('node_modules/.cache/rbv-tests');
fs.mkdirSync(cacheDir, { recursive: true });
const tmpOut = path.join(cacheDir, `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);

try {
  buildSync({
    entryPoints: [path.resolve(targetScript)],
    outfile: tmpOut,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external'
  });

  execFileSync(process.execPath, [tmpOut, ...extraArgs], { stdio: 'inherit' });
} finally {
  if (fs.existsSync(tmpOut)) {
    fs.unlinkSync(tmpOut);
  }
}
