# RBV-UT to PDF Exporter (Edge & Chrome Extension)

Ekstensi peramban mandiri (Manifest V3) untuk Microsoft Edge dan Google Chrome yang mengekstrak Buku Materi Pokok (BMP) digital dari platform Kotobee Reader Universitas Terbuka (`https://univterbuka.kotobee.com/`) menjadi satu file **PDF utuh per buku** (termasuk teks selectable, rumus, tabel, gambar, dan bookmarks/daftar isi) yang dioptimalkan untuk **NotebookLM**.

---

## 🛠️ Tech Stack & Prasyarat

- **Runtime:** Node.js (v18+ direkomendasikan, teruji pada Node v24) & npm
- **Arsitektur:** Chrome Manifest V3 (MV3)
- **Bahasa:** TypeScript (`strict: true`)
- **Bundler:** Vite 6 (Multi-target ESM & IIFE bundler)
- **Silent PDF Engine:** Chrome DevTools Protocol (CDP) via `chrome.debugger`
- **PDF Assembly:** `pdf-lib` (Fase 4)
- **UI:** Floating In-Page Widget terisolasi dalam Shadow DOM

---

## 🚀 Panduan Kompilasi & Build

### 1. Instalasi Dependensi
```bash
npm install
```

### 2. Kompilasi Kode Ekstensi
Jalankan perintah build untuk mengompilasi TypeScript dan membungkus bundle ke folder `dist/`:
```bash
npm run build
```

Untuk mode pengembangan berkelanjutan (*watch mode*):
```bash
npm run dev
```

Untuk pengecekan tipe statis:
```bash
npm run type-check
```

Hasil kompilasi akan berada di direktori `dist/`:
```
dist/
├── manifest.json
├── background.js
├── content.js
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

---

## 📥 Panduan Instalasi di Browser

### Microsoft Edge
1. Buka Microsoft Edge dan kunjungi URL internal: `edge://extensions`
2. Pada panel navigasi kiri bawah, aktifkan toggle **Developer mode** (Mode Pengembang).
3. Klik tombol **Load unpacked** (Muat ekstensi yang belum dikemas) di bagian atas.
4. Pilih folder `dist/` dari repositori ini (`ut-digital-book-scrapper/dist`).
5. Ekstensi **RBV-UT to PDF Exporter** akan muncul di daftar ekstensi dengan status aktif tanpa error (*Errors: 0*).

### Google Chrome
1. Buka Google Chrome dan kunjungi URL: `chrome://extensions`
2. Aktifkan toggle **Developer mode** di sudut kanan atas.
3. Klik tombol **Load unpacked** di sudut kiri atas.
4. Pilih folder `dist/`.
5. Ekstensi berhasil terpasang dan siap digunakan.

---

## 📖 Cara Penggunaan di Kotobee Reader UT

1. Buka platform Kotobee Reader UT: [https://univterbuka.kotobee.com/](https://univterbuka.kotobee.com/)
2. Lakukan login akun SSO UT Anda seperti biasa.
3. Buka modul buku digital yang ingin Anda baca/ekspor.
4. Di pojok kanan bawah halaman buku, widget melayang **📖 RBV-UT Exporter** akan otomatis muncul dalam Shadow DOM terisolasi.
5. Judul buku yang aktif akan terdeteksi otomatis pada kartu antarmuka.

---

## 📂 Struktur Proyek

```
ut-digital-book-scrapper/
├── public/                     # Aset statis & manifest
│   ├── manifest.json           # Deklarasi Manifest V3
│   └── icons/                  # Ikon ekstensi (16, 48, 128px)
├── src/
│   ├── background/             # Service Worker (ES Module)
│   │   ├── index.ts            # Entry background
│   │   ├── debugger-manager.ts # Abstraksi lifecycle chrome.debugger
│   │   └── message-router.ts   # Router komunikasi typed message
│   ├── content/                # Content Script (IIFE)
│   │   ├── index.ts            # Entry content script
│   │   ├── dom-detector.ts     # Deteksi elemen Kotobee & judul buku
│   │   └── ui-injector.ts      # Pemasang Shadow DOM
│   ├── ui/                     # Komponen antarmuka pengguna
│   │   ├── widget.ts           # Floating widget logic & state
│   │   └── widget.css          # Scoped CSS di dalam Shadow DOM
│   ├── types/                  # TypeScript interfaces & types
│   │   ├── messages.ts         # Protokol perpesanan terisolasi
│   │   ├── exporter.ts         # Konfigurasi & status ekspor
│   │   └── vite-env.d.ts       # Deklarasi lingkungan Vite
│   └── utils/
│       ├── logger.ts           # Colorized prefixed logger
│       └── sanitize.ts         # Pembersih nama file OS-safe
├── scripts/
│   ├── build.js                # Dual-target Vite build pipeline
│   └── generate-icons.js       # Generator ikon PNG
├── docs/                       # Dokumentasi arsitektur proyek
└── package.json
```

---

## 🗺️ Roadmap Fase Pengerjaan

- [x] **Fase 1: Project Scaffolding & Manifest V3 Baseline** *(Selesai)*
- [ ] **Fase 2: CDP Silent Print & Single Chapter Clean Exporter** *(Next)*
- [ ] **Fase 3: Auto-Pagination & Multi-Frame Navigation Engine**
- [ ] **Fase 4: PDF Assembler (`pdf-lib`), Bookmarks/TOC & Download Manager**
- [ ] **Fase 5: UI/UX Widget, Error Resilience & Edge Add-ons Packaging**
