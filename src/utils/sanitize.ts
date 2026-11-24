/**
 * Sanitizes a title string to be safe for OS file naming.
 * Strips Windows/Linux reserved characters: \ / : * ? " < > |
 */
export function sanitizeFilename(title: string, defaultName = 'Buku_Materi_Pokok_UT'): string {
  if (!title || typeof title !== 'string') {
    return `${defaultName}.pdf`;
  }

  // Remove illegal characters
  let clean = title.replace(/[\\/:*?"<>|]/g, '_');

  // Collapse multiple underscores or spaces
  clean = clean.replace(/[\s_]+/g, '_').trim();

  // Strip leading/trailing dots or underscores
  clean = clean.replace(/^[_.]+|[_.]+$/g, '');

  // Truncate to reasonable length (e.g. 120 chars) to prevent Windows path length issues
  if (clean.length > 120) {
    clean = clean.substring(0, 120);
  }

  if (!clean) {
    clean = defaultName;
  }

  if (!clean.toLowerCase().endsWith('.pdf')) {
    clean += '.pdf';
  }

  return clean;
}
