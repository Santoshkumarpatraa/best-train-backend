if (!String.prototype.sanitize) {
          String.prototype.sanitize = function () {
                    const str = String(this);
                    return str.replace(/[%_\\]/g, '\\$&');
          };
}