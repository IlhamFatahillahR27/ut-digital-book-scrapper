# RBV-UT to PDF Exporter (Edge & Chrome Extension)

Ekstensi peramban mandiri (**Manifest V3**) untuk Microsoft Edge dan Google Chrome yang mengekstrak Buku Materi Pokok (BMP) digital dari platform Kotobee Reader Universitas Terbuka (`https://univterbuka.kotobee.com/`) menjadi satu file **PDF utuh per modul/buku** — lengkap dengan teks yang dapat diseleksi (*searchable text*), rumus, tabel, gambar, serta **Bookmarks / Daftar Isi hierarkis** yang dioptimalkan untuk **NotebookLM**.

---

## ✨ Fitur Utama (v1.0.0)

- **Isolated Print Stage (Zero Live DOM Disruption):** Mencetak konten buku secara bersih tanpa sidebar kiri/kanan, header, tombol zoom, atau pola arsir, tanpa merusak tampilan baca Kotobee.
- **Auto-Navigator per Modul & Rentang Kustom:** Otomatis memindai Daftar Isi (TOC) Kotobee untuk mengekspor per Modul, rentang chapter manual, atau seluruh buku.
- **PDF Assembler & Hierarchical Bookmarks (`pdf-lib`):** Menggabungkan seluruh halaman secara inkremental ke dalam satu file PDF ber-bookmark dengan unduhan andal via MV3 Offscreen Blob URL (mendukung file besar).
- **Progress Bar Interaktif & 1-Klik Resume:** Menampilkan persentase, format *"Halaman X dari Y (Modul Z)"*, badge fase, ukuran MB, estimasi waktu (ETA), mini-progress saat diperkecil, dan tombol **Lanjutkan dari Ch X** bila ekspor dihentikan/parsial.
- **Error Resilience & Circuit Breaker:** Timeout terukur pada CDP `Page.printToPDF`, retry bertingkat (*exponential backoff*), deteksi koneksi offline & sesi SSO UT berakhir, skip halaman gagal otomatis, serta Circuit Breaker (auto-stop + simpan parsial setelah 3 kegagalan beruntun).
- **Siap Rilis Edge Add-ons:** Skrip pengemasan POSIX-safe ZIP + pre-flight compliance validator (`npm run package`).

---

## 🛠️ Tech Stack & Prasyarat

- **Runtime:** Node.js (v18+ direkomendasikan, teruji pada Node v24) & npm
- **Arsitektur:** Chrome Manifest V3 (MV3, Chromium/Edge 116+)
- **Bahasa:** TypeScript (`strict: true`)
- **Bundler:** Vite 6 (Multi-target ESM & IIFE bundler)
- **Silent PDF Engine:** Chrome DevTools Protocol (CDP) via `chrome.debugger`
- **PDF Assembly:** `pdf-lib`
- **UI:** Floating In-Page Widget terisolasi dalam Shadow DOM + persistensi `chrome.storage.local`

---

## 🚀 Panduan Kompilasi, Build & Packaging

### 1. Instalasi Dependensi
```bash
npm install
```

### 2. Kompilasi Kode Ekstensi
```bash
npm run build
```

Mode pengembangan (*watch mode*):
```bash
npm run dev
```

Pengecekan tipe statis:
```bash
npm run type-check
```

### 3. Kemas ZIP Siap Unggah ke Microsoft Edge Add-ons
```bash
npm run package
```

Perintah `npm run package` otomatis menjalankan `npm run build`, memvalidasi kepatuhan manifest/ikon/file terlarang, lalu menghasilkan arsip POSIX-safe ZIP di:
```text
releases/rbv-ut-to-pdf-exporter-v1.0.0-edge.zip
```

Lihat panduan lengkap pengajuan ke Partner Center di [docs/edge-addons-submission.md](docs/edge-addons-submission.md).

---

## 📥 Panduan Instalasi (Load Unpacked)

### Microsoft Edge
1. Buka `edge://extensions`.
2. Aktifkan **Developer mode** (Mode Pengembang) di panel kiri bawah.
3. Klik **Load unpacked** dan pilih folder `dist/`.
4. Ekstensi **RBV-UT to PDF Exporter v1.0.0** aktif tanpa error (*Errors: 0*).

### Google Chrome
1. Buka `chrome://extensions`.
2. Aktifkan **Developer mode** di sudut kanan atas.
3. Klik **Load unpacked** dan pilih folder `dist/`.

---

## 📖 Cara Penggunaan di Kotobee Reader UT

1. Buka [https://univterbuka.kotobee.com/](https://univterbuka.kotobee.com/) dan login dengan akun SSO UT Anda.
2. Buka buku BMP yang ingin diekspor. Widget melayang **RBV-UT Exporter** akan muncul otomatis di sudut kanan atas (klik ikon ekstensi di toolbar untuk memperkecil/membuka kembali).
3. Pilih **Modul** pada dropdown (atau isi rentang `Dari Ch` – `Sampai Ch` secara manual).
4. Klik **🚀 Ekspor ke 1 File PDF** (atau **📄 Cetak Halaman Aktif** untuk 1 halaman saja).
5. Pantau progres melalui progress bar & estimasi waktu. Jika perlu berhenti di tengah proses, klik **⏹ Berhenti & Simpan Parsial** — PDF parsial akan tetap diunduh dan tombol **▶ Lanjutkan dari Ch X** tersedia untuk meneruskan sisa halaman.
6. Untuk opsi lanjutan (jumlah retry, timeout halaman, mode debug per halaman, atau salin diagnostik DOM), buka panel lipat **⚙ Alat Lanjutan & Diagnostik**.

---

## 📂 Struktur Proyek

```text
ut-digital-book-scrapper/
├── public/
│   ├── manifest.json                 # Deklarasi Manifest V3 (v1.0.0)
│   ├── offscreen.html                # Dokumen Offscreen MV3 untuk Blob URL besar
│   └── icons/                        # Ikon PNG tervalidasi (16, 32, 48, 128px)
├── src/
│   ├── background/                   # Service Worker (ES Module)
│   │   ├── index.ts                  # Entry SW, action toggle & keep-alive port
│   │   ├── debugger-manager.ts       # Lifecycle chrome.debugger & error formatter
│   │   ├── cdp-printer.ts            # CDP Page.printToPDF dengan timeout guard
│   │   ├── export-orchestrator.ts    # Batch navigator, retry backoff & circuit breaker
│   │   ├── pdf-assembler.ts          # Penggabungan PDF inkremental (pdf-lib)
│   │   ├── pdf-outlines.ts           # Penyusun Bookmarks / Document Outline
│   │   ├── pdf-downloader.ts         # Unduhan Offscreen Blob / fallback chunks
│   │   └── message-router.ts         # Router pesan & real-time progress push
│   ├── content/                      # Content Script (IIFE, top-frame guarded)
│   │   ├── index.ts                  # Entry content script & health check
│   │   ├── dom-detector.ts           # Deteksi kontainer Kotobee & metadata buku
│   │   ├── toc-parser.ts             # Parser Daftar Isi & pengelompokan modul
│   │   ├── page-navigator.ts         # Auto-navigator & DOM quiescence detector
│   │   ├── print-styler.ts           # Isolated Print Stage (FXL & Reflowable)
│   │   └── ui-injector.ts            # Pemasang Shadow DOM & viewport clamping
│   ├── offscreen/
│   │   └── index.ts                  # Worker pembentuk Blob URL untuk file besar
│   ├── ui/
│   │   ├── widget.ts                 # Floating widget, progress card & resume flow
│   │   └── widget.css                # Scoped CSS di dalam Shadow DOM
│   ├── types/
│   │   ├── cdp.ts
│   │   ├── exporter.ts
│   │   ├── messages.ts
│   │   └── vite-env.d.ts
│   └── utils/
│       ├── logger.ts
│       ├── sanitize.ts
│       └── storage.ts                # Persistensi preferensi via chrome.storage.local
├── scripts/
│   ├── build.js                      # Multi-target Vite production build
│   ├── package.js                    # Pre-flight validator & POSIX-safe ZIP packager
│   └── generate-icons.js
├── docs/
│   ├── blueprint_aplikasi_rbv_ut_to_pdf_exporter.md
│   └── edge-addons-submission.md     # Panduan submission & Privacy Policy
└── package.json
```

---

## 🗺️ Roadmap Fase Pengerjaan

- [x] **Fase 1: Project Scaffolding & Manifest V3 Baseline** *(Selesai)*
- [x] **Fase 2: CDP Silent Print & Single Chapter Clean Exporter** *(Selesai)*
- [x] **Fase 3: Module & Page Range Auto-Navigator** *(Selesai)*
- [x] **Fase 4: PDF Assembler (`pdf-lib`), Bookmarks/TOC & Download Manager** *(Selesai)*
- [x] **Fase 5: UI/UX Progress Bar, Error Resilience & Edge Add-ons Packaging** *(Selesai — v1.0.0)*
