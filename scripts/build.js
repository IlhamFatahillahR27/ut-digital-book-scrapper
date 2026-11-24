import { build } from 'vite';
import path from 'path';
import fs from 'fs';

const isWatch = process.argv.includes('--watch');
const distDir = path.resolve('dist');
const publicDir = path.resolve('public');

function copyPublicAssets() {
  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, distDir, { recursive: true });
    console.log('[Build] Copied public assets (manifest.json, icons) to dist/');
  }
}

async function runBuild() {
  console.log('[Build] Starting extension build...');

  if (!isWatch && fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Build Background Service Worker (ES Module)
  console.log('[Build] Bundling Background Service Worker (ESM)...');
  await build({
    configFile: false,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: path.resolve('src/background/index.ts'),
        formats: ['es'],
        fileName: () => 'background.js'
      },
      watch: isWatch ? {} : null,
      rollupOptions: {
        output: {
          entryFileNames: 'background.js',
          extend: true
        }
      }
    }
  });

  // 2. Build Content Script (IIFE for browser frame execution)
  console.log('[Build] Bundling Content Script (IIFE)...');
  await build({
    configFile: false,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: path.resolve('src/content/index.ts'),
        formats: ['iife'],
        name: 'RbvUtContentScript',
        fileName: () => 'content.js'
      },
      watch: isWatch ? {} : null,
      rollupOptions: {
        output: {
          entryFileNames: 'content.js',
          extend: true
        }
      }
    }
  });

  // 3. Build Offscreen Document Script (IIFE for MV3 Blob URL creation)
  console.log('[Build] Bundling Offscreen Script (IIFE)...');
  await build({
    configFile: false,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: path.resolve('src/offscreen/index.ts'),
        formats: ['iife'],
        name: 'RbvUtOffscreenScript',
        fileName: () => 'offscreen.js'
      },
      watch: isWatch ? {} : null,
      rollupOptions: {
        output: {
          entryFileNames: 'offscreen.js',
          extend: true
        }
      }
    }
  });

  // 4. Copy public assets
  copyPublicAssets();

  console.log('✅ [Build] Build completed successfully! Extension is ready in dist/\n');
}

runBuild().catch((err) => {
  console.error('❌ [Build] Build failed:', err);
  process.exit(1);
});
