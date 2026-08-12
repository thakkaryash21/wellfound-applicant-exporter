// One copy. It was duplicated byte-identically in panel.js and library.js, which
// is one copy too many for the function that stands between an applicant's name
// and the panel's innerHTML.
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
