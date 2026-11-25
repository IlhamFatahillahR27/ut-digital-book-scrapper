# RBV-UT to PDF Exporter (Edge & Chrome Extension)

A standalone **Manifest V3** browser extension for Microsoft Edge and Google Chrome that exports digital textbooks (*Buku Materi Pokok / BMP*) from the Universitas Terbuka (UT) Kotobee Reader (`https://univterbuka.kotobee.com/`) into a single **clean, searchable PDF per module or full book**—preserving selectable text, equations, tables, diagrams, and **hierarchical Bookmarks (Table of Contents)** optimized for **NotebookLM**.

---

## ✨ Key Features (v1.1.0)

- **Isolated Print Stage (Zero Live DOM Disruption):** Extracts active chapter content into an isolated `@media print` stage, completely removing Kotobee sidebars, headers, zoom buttons, and hatched backgrounds without disturbing the live Ionic 1 reader layout.
- **Contiguous Multi-TOC Selection & Auto-Navigator:** Automatically scans the Kotobee Table of Contents (TOC) into a scrollable checklist where you can select one or multiple adjacent TOC sections (above/below without skipping pages), use 1-click **Semua** / **Reset** actions, or fine-tune with manual `Dari Ch` – `Sampai Ch` inputs—with automatic Single-Page view switching and restoration.
- **Incremental PDF Assembler & Bookmarks (`pdf-lib`):** Stitches captured chapter buffers incrementally into one structured PDF with hierarchical Document Outlines, downloaded reliably via an MV3 Offscreen Blob URL worker (supports large multi-megabyte files).
- **Interactive Progress Card & 1-Click Resume:** Displays real-time progress percentage, `"Halaman X dari Y (Modul Z)"` status, phase badge, live MB size, rolling ETA, minimized mini-progress bar, **Stop & Save Partial**, and 1-click **Resume from last chapter**.
- **Error Resilience & Circuit Breaker:** Protected by a bounded CDP `Page.printToPDF` timeout guard, exponential-backoff retries, offline recovery wait, UT SSO session-expiry detection, single-chapter skip-and-continue, and a 3-consecutive-failure circuit breaker with automatic partial PDF rescue.
- **Edge Add-ons Ready Packaging:** Zero-dependency POSIX-safe ZIP builder and pre-flight store compliance validator (`npm run package`).

---

## 🛠️ Tech Stack & Prerequisites

- **Runtime:** Node.js (v18+ recommended, verified on Node v24) & npm
- **Architecture:** Chrome Manifest V3 (Chromium / Edge 116+)
- **Language:** TypeScript (`strict: true`)
- **Bundler:** Vite 6 (Multi-target ESM & IIFE pipeline)
- **Silent PDF Engine:** Chrome DevTools Protocol (CDP) via `chrome.debugger` (`Page.printToPDF`)
- **PDF Assembly:** `pdf-lib`
- **UI:** Shadow DOM floating widget with `chrome.storage.local` preference persistence

---

## 🚀 Build & Release Packaging

### 1. Install Dependencies
```bash
npm install
```

### 2. Build the Extension
```bash
npm run build
```

Watch mode during development:
```bash
npm run dev
```

Static type check & contiguous TOC unit tests:
```bash
npm run type-check
npm run test:toc
```

### 3. Build Release ZIP for Microsoft Edge Add-ons
```bash
npm run package
```

`npm run package` runs `npm run build`, executes pre-flight store compliance checks (manifest schema, version sync, binary PNG icon dimensions, forbidden dev files), and generates a POSIX-safe ZIP archive at:
```text
releases/rbv-ut-to-pdf-exporter-v1.1.0-edge.zip
```

See [docs/edge-addons-submission.md](docs/edge-addons-submission.md) for the Partner Center submission guide, [docs/edge-release-notes-v1.1.0.md](docs/edge-release-notes-v1.1.0.md) for release notes, and [POLICY.md](POLICY.md) for the public Privacy Policy.

---

## 📥 Local Installation (Load Unpacked)

### Microsoft Edge
1. Open `edge://extensions`.
2. Enable **Developer mode** in the left sidebar.
3. Click **Load unpacked** and select the `dist/` directory.
4. **RBV-UT to PDF Exporter v1.1.0** will appear active with `Errors: 0`.

### Google Chrome
1. Open `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `dist/` directory.

---

## 📖 Usage on UT Kotobee Reader

1. Sign in to [https://univterbuka.kotobee.com/](https://univterbuka.kotobee.com/) with your Universitas Terbuka SSO account.
2. Open any digital BMP textbook. The floating **RBV-UT Exporter** widget mounts automatically in the top-right corner (click the extension toolbar icon anytime to minimize or expand it).
3. Choose one or multiple **adjacent TOC sections** in the scrollable checklist (extend upward/downward as a single unbroken range, click **Semua** for the whole book, click **Reset** to start from a different section, or specify a custom `Dari Ch` – `Sampai Ch` chapter range).
4. Click **🚀 Ekspor ke 1 File PDF** to export the entire range into one bookmarked PDF, or **📄 Cetak Halaman Aktif** to export only the current page.
5. Track live progress, MB captured, and ETA in the progress card. Click **⏹ Berhenti & Simpan Parsial** anytime to stop gracefully, save all captured pages so far, and resume later via the 1-click **▶ Lanjutkan dari Ch X** button.
6. Expand **⚙ Alat Lanjutan & Diagnostik** to configure max retries, per-page timeout, per-page debug output, or copy DOM/TOC diagnostics.

---

## 📂 Project Structure

```text
ut-digital-book-scrapper/
├── POLICY.md                         # Public Privacy Policy for Microsoft Edge Add-ons
├── README.md                         # Project documentation
├── public/
│   ├── manifest.json                 # Manifest V3 declaration (v1.1.0)
│   ├── offscreen.html                # MV3 Offscreen document for large Blob downloads
│   └── icons/                        # Validated PNG icons (16, 32, 48, 128px)
├── src/
│   ├── background/                   # Service Worker (ES Module)
│   │   ├── index.ts                  # Entry SW, toolbar toggle & keep-alive port
│   │   ├── debugger-manager.ts       # chrome.debugger lifecycle & friendly error mapper
│   │   ├── cdp-printer.ts            # CDP Page.printToPDF with timeout & %PDF guard
│   │   ├── export-orchestrator.ts    # Batch engine, retry backoff & circuit breaker
│   │   ├── pdf-assembler.ts          # Incremental pdf-lib document merger
│   │   ├── pdf-outlines.ts           # Hierarchical PDF Bookmark / Outline builder
│   │   ├── pdf-downloader.ts         # Offscreen Blob / chunked fallback downloader
│   │   └── message-router.ts         # Typed message router & real-time progress push
│   ├── content/                      # Content Script (IIFE, top-frame idempotent)
│   │   ├── index.ts                  # Entry content script & page health checks
│   │   ├── dom-detector.ts           # Kotobee reader & metadata detection
│   │   ├── toc-parser.ts             # TOC extractor & Module range grouper
│   │   ├── page-navigator.ts         # Auto-navigator & DOM quiescence observer
│   │   ├── print-styler.ts           # Isolated Print Stage (FXL & Reflowable)
│   │   └── ui-injector.ts            # Shadow DOM host mount & viewport clamping
│   ├── offscreen/
│   │   └── index.ts                  # Blob URL assembly worker for large PDFs
│   ├── ui/
│   │   ├── toc-selection.ts          # Pure contiguous multi-TOC selection state machine
│   │   ├── widget.ts                 # Floating widget state, TOC checklist, progress card & resume flow
│   │   └── widget.css                # Scoped Shadow DOM styles
│   ├── types/
│   │   ├── cdp.ts
│   │   ├── exporter.ts
│   │   ├── messages.ts
│   │   └── vite-env.d.ts
│   └── utils/
│       ├── logger.ts
│       ├── sanitize.ts
│       └── storage.ts                # chrome.storage.local preference wrapper
├── scripts/
│   ├── build.js                      # Multi-target Vite production build
│   ├── package.js                    # Pre-flight store validator & POSIX ZIP packager
│   ├── generate-icons.js
│   ├── run-ts-test.js                # Standalone TypeScript test runner
│   ├── test-toc-selection.ts         # Automated contiguous multi-TOC selection unit tests
│   └── test-fase5-resilience.ts      # Automated resilience & circuit breaker tests
├── docs/
│   ├── blueprint_aplikasi_rbv_ut_to_pdf_exporter.md
│   ├── edge-addons-submission.md     # Microsoft Edge Partner Center submission guide
│   ├── edge-release-notes-v1.0.0.md  # Edge/Chrome v1.0.0 release notes
│   └── edge-release-notes-v1.1.0.md  # Edge/Chrome v1.1.0 release notes
└── package.json
```

---

## 🔒 Privacy Policy

This extension processes all pages **100% locally** inside your browser and never collects or transmits personal data, credentials, or book contents. Read the full policy in [POLICY.md](POLICY.md).

---

## 🗺️ Development Roadmap

- [x] **Phase 1: Project Scaffolding & Manifest V3 Baseline** *(Completed)*
- [x] **Phase 2: CDP Silent Print & Single Chapter Clean Exporter** *(Completed)*
- [x] **Phase 3: Module & Page Range Auto-Navigator** *(Completed)*
- [x] **Phase 4: PDF Assembler (`pdf-lib`), Bookmarks & Module Stitching** *(Completed)*
- [x] **Phase 5: UI/UX Progress Bar, Error Resilience & Edge Add-ons Packaging** *(Completed — v1.0.0)*
- [x] **v1.1.0: Contiguous Multi-TOC Selection Checklist & Two-Way Range Sync** *(Completed — v1.1.0)*
