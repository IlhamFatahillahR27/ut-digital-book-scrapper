# Privacy Policy — RBV-UT to PDF Exporter (Firefox Add-on)

**Effective Date:** November 25, 2026  
**Extension Name:** RBV-UT to PDF Exporter  
**Gecko Add-on ID:** `rbv-ut-pdf-exporter@ut-helper.mozilla`  
**Version:** 1.1.0  

---

## 1. Overview

**RBV-UT to PDF Exporter** is a Manifest V3 browser add-on for **Mozilla Firefox** designed to help Universitas Terbuka (UT) students export digital textbooks (*Buku Materi Pokok / BMP*) from their authorized Kotobee Reader portal (`https://univterbuka.kotobee.com/`) into clean, crisp, searchable vector PDF documents for personal offline study and tools such as NotebookLM.

We are committed to protecting your privacy. This add-on operates **100% locally** inside your Firefox browser, declares `"data_collection_permissions": { "required": ["none"] }`, and does **not** collect, store remotely, transmit, or sell any personal or technical user data.

---

## 2. Data We Do NOT Collect

RBV-UT to PDF Exporter does **not** collect, access externally, or transmit any of the following:
- Personally Identifiable Information (name, email address, student ID/NIM, phone number)
- Authentication credentials, passwords, SSO tokens, or session cookies
- Browsing history or activity on any website outside `https://univterbuka.kotobee.com/`
- Book contents, exported PDF files, or reading notes
- Device telemetry, analytics, crash reports, or usage tracking metrics

---

## 3. Local Processing & Storage

- **100% Client-Side Execution:** All DOM inspection, chapter consolidation into an isolated `@media print` stage, and native vector PDF export via Firefox's `browser.tabs.saveAsPDF()` occur entirely inside your local Firefox browser session. Zero network requests are sent to external servers by the extension.
- **Local UI Preferences Only:** The extension uses `browser.storage.local` solely to remember your local interface preferences on your own device (floating widget position, minimized state, retry count, and page timeout configuration). This data never leaves your browser and is removed automatically if you uninstall the add-on.

---

## 4. Browser Permissions & Justification

To deliver its core single-purpose functionality, the extension requests only the minimum required Firefox Manifest V3 permissions:

| Permission / Host | Purpose |
| :--- | :--- |
| `https://univterbuka.kotobee.com/*` | Restricts the add-on strictly to the official Universitas Terbuka Kotobee digital textbook portal. The extension does not run on or access any other website. |
| `storage` | Used via `browser.storage.local` strictly to store local UI preferences (widget position, minimized state, and retry/timeout settings). |
| `activeTab` & `scripting` | Used when the user clicks the extension toolbar icon on `https://univterbuka.kotobee.com/` to request host access if needed and safely toggle or mount the floating exporter widget without duplicate injection. |

---

## 5. Third-Party Services & Data Sharing

- RBV-UT to PDF Exporter does **not** integrate with any third-party analytics, advertising networks, tracking pixels, or remote APIs.
- Because no user data is collected, no user data is ever shared with, sold to, or transferred to third parties.

---

## 6. Copyright & Acceptable Use

This extension is intended strictly for personal educational study by Universitas Terbuka students who hold authorized SSO access to their respective digital textbooks. Users are solely responsible for complying with Universitas Terbuka's terms of use and applicable copyright laws, and must not redistribute exported materials commercially or publicly.

---

## 7. Changes to This Policy

If future updates change how permissions or local storage are used, this `POLICY.md` file and `browser_specific_settings.gecko.data_collection_permissions` in `manifest.json` will be updated prior to publishing the new add-on version.

---

## 8. Contact

If you have questions or privacy concerns regarding **RBV-UT to PDF Exporter**, please open an issue on the project's official source repository or contact the developer through the support link listed on the Mozilla Add-ons (AMO) listing page.
