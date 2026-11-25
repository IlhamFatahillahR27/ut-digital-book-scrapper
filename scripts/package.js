/**
 * Mozilla Firefox Add-ons (AMO) Release Packager, Source Archiver & Pre-Flight Compliance Validator.
 * Zero external dependencies: builds deterministic, POSIX-path ZIP archives using Node's built-in zlib.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const VERIFY_ONLY = process.argv.includes('--verify-only');
const DIST_DIR = path.resolve('dist');
const RELEASES_DIR = path.resolve('releases');
const PKG_PATH = path.resolve('package.json');
const ROOT_DIR = path.resolve('.');

const FORBIDDEN_DIST_PATTERNS = [
  /^icon_ut\.png$/i,
  /^offscreen\.(html|js)$/i,
  /\.map$/i,
  /^\.env/i,
  /\.DS_Store$/i,
  /^Thumbs\.db$/i
];

const CHROMIUM_ONLY_PERMISSIONS = new Set(['debugger', 'offscreen']);

const SOURCE_EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'releases',
  'tmp-pdf-test',
  'docs',
  'evidences'
]);

const SOURCE_EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'start-edge-remote.ps1']);

// Standard IEEE 802.3 CRC-32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Recursively collects all files in dir and returns sorted POSIX relative paths.
 */
function collectFiles(dir, baseDir = dir, options = {}) {
  const { excludeDirs = new Set(), excludeFiles = new Set() } = options;
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excludeDirs.has(entry.name)) {
      continue;
    }
    if (entry.isFile() && excludeFiles.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, baseDir, options));
    } else if (entry.isFile()) {
      const relPosix = path.relative(baseDir, full).split(path.sep).join('/');
      results.push({ fullPath: full, posixPath: relPosix });
    }
  }
  return results.sort((a, b) => a.posixPath.localeCompare(b.posixPath));
}

/**
 * Validates PNG signature and IHDR pixel dimensions.
 */
function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error(`File bukan PNG valid: ${filePath}`);
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw new Error(`Header IHDR PNG tidak valid: ${filePath}`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

/**
 * Runs Mozilla Firefox Add-ons (AMO) compliance checks on dist/.
 */
function validateDist() {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('Folder dist/ tidak ditemukan. Jalankan "npm run build" terlebih dahulu.');
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const manifestPath = path.join(DIST_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('dist/manifest.json tidak ditemukan.');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (manifest.manifest_version !== 3) {
    errors.push(`manifest_version harus 3, ditemukan: ${manifest.manifest_version}`);
  }
  if (manifest.version !== pkg.version) {
    errors.push(`Versi tidak sinkron: manifest.json (${manifest.version}) !== package.json (${pkg.version})`);
  }
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(manifest.version || '')) {
    errors.push(`Format versi tidak valid untuk AMO: "${manifest.version}"`);
  }
  if (!manifest.name || manifest.name.length > 45) {
    errors.push(`Nama ekstensi tidak valid atau melebihi 45 karakter (${manifest.name?.length ?? 0}).`);
  }
  if (!manifest.description || manifest.description.length > 132) {
    errors.push(`Deskripsi manifest melebihi 132 karakter (${manifest.description?.length ?? 0}).`);
  }

  // Validate Firefox browser_specific_settings.gecko
  const gecko = manifest.browser_specific_settings?.gecko;
  if (!gecko) {
    errors.push('Manifest Firefox wajib memiliki browser_specific_settings.gecko.');
  } else {
    if (!gecko.id || typeof gecko.id !== 'string') {
      errors.push('browser_specific_settings.gecko.id wajib diisi untuk AMO.');
    }
    const minMajor = parseInt(String(gecko.strict_min_version || '0').split('.')[0], 10);
    if (Number.isNaN(minMajor) || minMajor < 140) {
      errors.push(
        `browser_specific_settings.gecko.strict_min_version harus >= 140.0 saat menggunakan data_collection_permissions (ditemukan: "${gecko.strict_min_version ?? ''}").`
      );
    }
    const dataPerms = gecko.data_collection_permissions?.required;
    if (!Array.isArray(dataPerms) || dataPerms.length === 0) {
      errors.push('browser_specific_settings.gecko.data_collection_permissions.required wajib diisi (misal ["none"]).');
    }
  }

  // Ensure zero Chromium-only keys or permissions remain
  if (manifest.minimum_chrome_version) {
    errors.push('Key minimum_chrome_version tidak boleh ada di manifest Firefox.');
  }
  if (manifest.background?.service_worker) {
    errors.push('Firefox MV3 harus menggunakan background.scripts, bukan background.service_worker.');
  }
  if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
    errors.push('background.scripts wajib diisi di manifest Firefox MV3.');
  }
  for (const perm of manifest.permissions || []) {
    if (CHROMIUM_ONLY_PERMISSIONS.has(perm)) {
      errors.push(`Permission khusus Chromium tidak didukung Firefox: "${perm}"`);
    }
  }

  // Check host_permissions are HTTPS-only (no wildcard http:// or <all_urls>)
  for (const hp of manifest.host_permissions || []) {
    if (hp.startsWith('http://') || hp === '<all_urls>' || hp.startsWith('*://')) {
      warnings.push(`Host permission lebar terdeteksi: "${hp}"`);
    }
  }

  // Verify required referenced files exist
  const referencedFiles = new Set();
  for (const bgScript of manifest.background?.scripts || []) {
    referencedFiles.add(bgScript);
  }
  for (const cs of manifest.content_scripts || []) {
    for (const jsFile of cs.js || []) referencedFiles.add(jsFile);
  }
  for (const iconPath of Object.values(manifest.icons || {})) {
    referencedFiles.add(iconPath);
  }
  for (const iconPath of Object.values(manifest.action?.default_icon || {})) {
    referencedFiles.add(iconPath);
  }

  for (const rel of referencedFiles) {
    if (!rel) continue;
    const abs = path.join(DIST_DIR, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`File referensi manifest hilang di dist/: ${rel}`);
    }
  }

  // Validate icon PNG binary dimensions
  for (const [sizeKey, iconRel] of Object.entries(manifest.icons || {})) {
    const expected = Number(sizeKey);
    const abs = path.join(DIST_DIR, iconRel);
    if (fs.existsSync(abs)) {
      try {
        const dims = readPngDimensions(abs);
        if (dims.width !== expected || dims.height !== expected) {
          errors.push(
            `Dimensi ikon ${iconRel} tidak sesuai: ${dims.width}x${dims.height} (harus ${expected}x${expected})`
          );
        }
      } catch (err) {
        errors.push(String(err));
      }
    }
  }

  // Collect all dist files & check forbidden patterns
  const files = collectFiles(DIST_DIR);
  for (const file of files) {
    const base = path.basename(file.posixPath);
    if (FORBIDDEN_DIST_PATTERNS.some((re) => re.test(base))) {
      errors.push(`File terlarang / sisa dev ditemukan di dist/: ${file.posixPath}`);
    }
    if (file.posixPath.includes('\\')) {
      errors.push(`Path non-POSIX terdeteksi: ${file.posixPath}`);
    }
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  Peringatan Compliance AMO:');
    for (const w of warnings) console.warn(`   - ${w}`);
  }

  if (errors.length > 0) {
    console.error('\n❌ Pre-Flight Firefox AMO Validation GAGAL:');
    for (const e of errors) console.error(`   - ${e}`);
    process.exit(1);
  }

  return { pkg, manifest, files };
}

/**
 * Builds a standards-compliant ZIP buffer (DEFLATE method 8, UTF-8 flag, POSIX forward-slash paths).
 */
function buildPosixZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file.fullPath);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;

    const crc = crc32(raw);
    const nameBuf = Buffer.from(file.posixPath, 'utf8');
    const stat = fs.statSync(file.fullPath);
    const { dosTime, dosDate } = toDosTimeDate(stat.mtime);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localChunks.push(lfh, nameBuf, payload);

    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(0x031e, 4);
    cdfh.writeUInt16LE(20, 6);
    cdfh.writeUInt16LE(0x0800, 8);
    cdfh.writeUInt16LE(method, 10);
    cdfh.writeUInt16LE(dosTime, 12);
    cdfh.writeUInt16LE(dosDate, 14);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(payload.length, 20);
    cdfh.writeUInt32LE(raw.length, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30);
    cdfh.writeUInt16LE(0, 32);
    cdfh.writeUInt16LE(0, 34);
    cdfh.writeUInt16LE(0, 36);
    cdfh.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cdfh.writeUInt32LE(offset, 42);

    centralChunks.push(cdfh, nameBuf);
    offset += lfh.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}

function verifyZipBuffer(zipBuf, expectedCount) {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65557); i--) {
    if (zipBuf.readUInt32LE(i) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('ZIP invalid: End of Central Directory tidak ditemukan.');
  }

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  if (totalEntries !== expectedCount) {
    throw new Error(`Jumlah entri ZIP tidak cocok: ${totalEntries} !== ${expectedCount}`);
  }

  const entries = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (zipBuf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Central Directory entry #${i} korup.`);
    }
    const nameLen = zipBuf.readUInt16LE(cursor + 28);
    const extraLen = zipBuf.readUInt16LE(cursor + 30);
    const commentLen = zipBuf.readUInt16LE(cursor + 32);
    const name = zipBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    if (name.includes('\\')) {
      throw new Error(`Entri ZIP mengandung backslash Windows: ${name}`);
    }
    entries.push(name);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function main() {
  console.log('🔍 [Package] Menjalankan Pre-Flight Firefox AMO Compliance Validation pada dist/...');
  const { manifest, files } = validateDist();

  const totalRawBytes = files.reduce((sum, f) => sum + fs.statSync(f.fullPath).size, 0);
  console.log(
    `✅ [Package] Validasi AMO lolos! ${files.length} file, v${manifest.version}, ` +
      `Gecko ID: ${manifest.browser_specific_settings.gecko.id}, ` +
      `total ${(totalRawBytes / 1024).toFixed(1)} KB uncompressed.`
  );

  if (VERIFY_ONLY) {
    console.log('ℹ️  [Package] Mode --verify-only selesai tanpa membuat arsip ZIP.');
    return;
  }

  fs.mkdirSync(RELEASES_DIR, { recursive: true });

  // 1. Build Firefox Add-on release ZIP
  const zipFilename = `rbv-ut-to-pdf-exporter-v${manifest.version}-firefox.zip`;
  const zipPath = path.join(RELEASES_DIR, zipFilename);
  const zipBuf = buildPosixZip(files);
  const verifiedEntries = verifyZipBuffer(zipBuf, files.length);
  fs.writeFileSync(zipPath, zipBuf);
  const sha256 = crypto.createHash('sha256').update(zipBuf).digest('hex');

  // 2. Build clean source-code ZIP required by AMO reviewers for bundled/TypeScript add-ons
  const sourceFiles = collectFiles(ROOT_DIR, ROOT_DIR, {
    excludeDirs: SOURCE_EXCLUDE_DIRS,
    excludeFiles: SOURCE_EXCLUDE_FILES
  }).filter(
    (f) =>
      !f.posixPath.endsWith('.zip') &&
      !f.posixPath.endsWith('.pdf') &&
      !f.posixPath.endsWith('.py') &&
      !f.posixPath.endsWith('.ps1')
  );

  const sourceZipFilename = `rbv-ut-to-pdf-exporter-v${manifest.version}-firefox-source.zip`;
  const sourceZipPath = path.join(RELEASES_DIR, sourceZipFilename);
  const sourceZipBuf = buildPosixZip(sourceFiles);
  verifyZipBuffer(sourceZipBuf, sourceFiles.length);
  fs.writeFileSync(sourceZipPath, sourceZipBuf);
  const sourceSha256 = crypto.createHash('sha256').update(sourceZipBuf).digest('hex');

  console.log('\n📦 [Package] Arsip rilis Mozilla Firefox Add-ons (AMO) berhasil dibuat:');
  console.log(`   Add-on ZIP : ${path.relative(process.cwd(), zipPath)}`);
  console.log(`   Versi      : v${manifest.version}`);
  console.log(`   Gecko ID   : ${manifest.browser_specific_settings.gecko.id}`);
  console.log(`   Ukuran ZIP : ${(zipBuf.length / 1024).toFixed(1)} KB (${(zipBuf.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`   SHA-256    : ${sha256}`);
  console.log(`   Entri (${verifiedEntries.length}) :`);
  for (const name of verifiedEntries) {
    console.log(`     - ${name}`);
  }
  console.log('\n📄 [Package] Arsip Source Code untuk Reviewer AMO berhasil dibuat:');
  console.log(`   Source ZIP : ${path.relative(process.cwd(), sourceZipPath)}`);
  console.log(`   File Count : ${sourceFiles.length} file`);
  console.log(`   Ukuran ZIP : ${(sourceZipBuf.length / 1024).toFixed(1)} KB`);
  console.log(`   SHA-256    : ${sourceSha256}`);
  console.log('\n✅ Siap diunggah ke Mozilla Add-ons Developer Hub (addons.mozilla.org)!\n');
}

main();
