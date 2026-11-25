# RBV-UT to PDF Exporter (Mozilla Firefox Add-on)

A lightweight, standalone **Manifest V3** browser add-on for **Mozilla Firefox (140+)** that exports digital textbooks (*Buku Materi Pokok / BMP*) from the Universitas Terbuka (UT) Kotobee Reader (`https://univterbuka.kotobee.com/`) into a single **clean, crisp, searchable vector PDF per module or custom range**—preserving selectable text, equations, tables, and diagrams optimized for **NotebookLM**.

---

## ✨ Key Features (Firefox MV3 — v1.0.0)

- **Native Vector PDF Engine (`browser.tabs.saveAsPDF`):** Navigates automatically across all chapters in the selected module/range, clones each page with uniquely scoped CSS and inlined `blob:` images into a single consolidated `@media print` stage, and invokes Firefox's native Gecko vector PDF engine (`browser.tabs.saveAsPDF()`) once at the end—producing sharp, compact, 100% searchable PDFs with zero Kotobee UI clutter.
- **Zero-`innerHTML` AMO-Safe Architecture:** Clones chapter nodes via `cloneNode(true)` / `document.importNode()` and constructs the Shadow DOM floating widget exclusively via safe DOM APIs—passing Mozilla's official `addons-linter` with **0 errors, 0 warnings, and 0 notices**.
- **Minimal Permissions:** Only requests `storage`, `activeTab`, `scripting`, and `https://univterbuka.kotobee.com/*` with `"data_collection_permissions": { "required": ["none"] }`.
- **Module & Custom Range Auto-Navigator:** Automatically scans Kotobee's Table of Contents (TOC) to group chapters by Module, with automatic Single-Page view switching and restoration.
- **Interactive Progress Card, Resilience & 1-Click Resume:** Real-time progress bar, percentage, collected page telemetry, rolling ETA, exponential-backoff retries, offline recovery wait, UT SSO expiry detection, single-chapter skip, a 3-consecutive-failure circuit breaker, **Stop & Save Partial**, and 1-click **Resume**.
- **AMO-Ready Packaging & Source Archiver:** Generates both the add-on `.zip` and the reviewer-required clean `-source.zip` with built-in AMO manifest compliance checks (`npm run package`).

---

## 🛠️ Tech Stack & Prerequisites

- **Runtime:** Node.js v22+ (tested on Node v24) & npm
- **Target Browser:** Mozilla Firefox Desktop **140.0+** (Manifest V3 Event Page)
- **Language:** TypeScript (`strict: true`, `@types/firefox-webext-browser`)
- **Bundler:** Vite 6 (ESM Background Event Page + IIFE Content Script)
- **PDF Engine:** Firefox Native Vector (`browser.tabs.saveAsPDF()` + `window.print()` fallback)
- **AMO Linter:** Official Mozilla `addons-linter` v10+

---

## 🚀 Build, Lint, Test & Release Packaging

```bash
npm install
npm run build
npm run lint:amo
npm run test:resilience
npm run package
```

`npm run package` runs `npm run build`, `npm run lint:amo`, and pre-flight AMO manifest/icon checks, producing two POSIX-safe archives in `releases/`:
- `releases/rbv-ut-to-pdf-exporter-v1.0.0-firefox.zip` *(Add-on package for AMO)*
- `releases/rbv-ut-to-pdf-exporter-v1.0.0-firefox-source.zip` *(Clean Source Code archive for AMO reviewers)*

---

## 📥 Local Installation in Firefox (Temporary Add-on)

1. Run `npm run build`.
2. Open `about:debugging#/runtime/this-firefox` in Mozilla Firefox.
3. Click **Load Temporary Add-on...** and select `dist/manifest.json`.
4. Open a textbook at [https://univterbuka.kotobee.com/](https://univterbuka.kotobee.com/) (signed in with your UT SSO account).
5. If the floating widget is not visible yet, click the **RBV-UT to PDF Exporter** toolbar icon and click **Allow** when Firefox asks for host access on `https://univterbuka.kotobee.com/*`.

---

## 📖 Usage on UT Kotobee Reader

1. Sign in to [https://univterbuka.kotobee.com/](https://univterbuka.kotobee.com/) and open any BMP textbook.
2. Select a **Module** from the dropdown (or enter a manual `Dari Ch` – `Sampai Ch` range).
3. Click **🚀 Ekspor ke 1 File PDF** to collect all chapters in the range and open Firefox's **Save As PDF** dialog once at the end (or **📄 Cetak Halaman Aktif** for only the active page).
4. Click **⏹ Berhenti & Simpan Parsial** anytime to stop gracefully and save already-collected chapters, then resume with **▶ Lanjutkan dari Ch X**.

---

## 🔒 Privacy Policy

This add-on processes all pages **100% locally** inside Firefox, declares `"data_collection_permissions": { "required": ["none"] }`, and never collects or transmits any personal data, credentials, or book contents. Read the full policy in [POLICY.md](POLICY.md).
