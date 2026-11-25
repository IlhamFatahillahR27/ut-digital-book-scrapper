# Privacy Policy — RBV-UT to PDF Exporter

**Effective Date:** November 25, 2026  
**Extension Name:** RBV-UT to PDF Exporter  
**Version:** 1.1.0  

---

## 1. Overview

**RBV-UT to PDF Exporter** is a browser extension for Microsoft Edge and Google Chrome designed to help Universitas Terbuka (UT) students export digital textbooks (*Buku Materi Pokok / BMP*) from their authorized Kotobee Reader portal (`https://univterbuka.kotobee.com/`) into clean, searchable PDF documents with hierarchical bookmarks for personal offline study and tools such as NotebookLM.

We are committed to protecting your privacy. This extension operates **100% locally** inside your browser and does **not** collect, store, transmit, or sell any personal data.

---

## 2. Data We Do NOT Collect

RBV-UT to PDF Exporter does **not** collect, access, or transmit any of the following:
- Personally Identifiable Information (name, email address, student ID/NIM, phone number)
- Authentication credentials, passwords, SSO tokens, or session cookies
- Browsing history or activity on any website outside `https://univterbuka.kotobee.com/`
- Book contents, exported PDF files, or reading notes
- Device telemetry, analytics, crash reports, or usage tracking metrics

---

## 3. Local Processing & Storage

- **100% Client-Side Execution:** All DOM inspection, PDF rendering (via Chrome DevTools Protocol `Page.printToPDF`), incremental PDF stitching (`pdf-lib`), bookmark generation, and file saving occur entirely inside your local browser session. Zero network requests are sent to external servers by the extension.
- **Local UI Preferences Only:** The extension uses `chrome.storage.local` solely to remember your local interface preferences on your own device (floating widget position, minimized state, retry count, and page timeout configuration). This data never leaves your browser and is removed automatically if you uninstall the extension.

---

## 4. Browser Permissions & Justification

To deliver its core single-purpose functionality, the extension requests only the minimum required Manifest V3 permissions:

| Permission / Host | Purpose |
| :--- | :--- |
| `https://univterbuka.kotobee.com/*` | Restricts the extension strictly to the official Universitas Terbuka Kotobee digital textbook portal. The extension does not run on any other website. |
| `debugger` | Used exclusively while an export is actively running to invoke Chrome DevTools Protocol `Page.printToPDF` silently without triggering repetitive OS print dialogs. The debugger attaches only when the user clicks export and detaches immediately upon completion, cancellation, or error. |
| `downloads` | Used to save the locally assembled PDF file directly into the user's local Downloads folder with an OS-safe sanitized filename. |
| `offscreen` | Used under Manifest V3 (`Reason.BLOBS`) to create a temporary local `blob:` URL for large stitched PDF files so they can be saved reliably via `chrome.downloads`, then immediately revoked after download completion. |
| `storage` | Used via `chrome.storage.local` to store local UI preferences (widget position, minimized state, and retry/timeout settings). |
| `activeTab` & `scripting` | Used when the user clicks the extension toolbar icon on `https://univterbuka.kotobee.com/` to toggle or mount the floating exporter widget safely without duplicate injection. |

---

## 5. Third-Party Services & Data Sharing

- RBV-UT to PDF Exporter does **not** integrate with any third-party analytics, advertising networks, tracking pixels, or remote APIs.
- Because no user data is collected, no user data is ever shared with, sold to, or transferred to third parties.

---

## 6. Copyright & Acceptable Use

This extension is intended strictly for personal educational study by Universitas Terbuka students who hold authorized SSO access to their respective digital textbooks. Users are solely responsible for complying with Universitas Terbuka's terms of use and applicable copyright laws, and must not redistribute exported materials commercially or publicly.

---

## 7. Changes to This Policy

If future updates change how permissions or local storage are used, this `POLICY.md` file will be updated with a revised effective date prior to publishing the new extension version.

---

## 8. Contact

If you have questions or privacy concerns regarding **RBV-UT to PDF Exporter**, please open an issue on the project's official source repository or contact the developer through the support link listed on the Microsoft Edge Add-ons store page.
