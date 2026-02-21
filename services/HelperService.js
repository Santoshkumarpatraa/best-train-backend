/**
 * Escapes % _ \ for safe use in SQL LIKE patterns.
 * Use: `%${String(search).sanitize()}%`
 */
if (!String.prototype.sanitize) {
  String.prototype.sanitize = function () {
    const str = String(this);
    return str.replace(/[%_\\]/g, "\\$&");
  };
}