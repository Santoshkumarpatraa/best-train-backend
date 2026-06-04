/**
 * Browser-like headers for API requests.
 */
module.exports = (() => {
  const DEFAULT_HEADERS = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Content-Language": "en",
    Pragma: "no-cache",
    "Priority": "u=1, i",
    "Sec-Ch-Ua": '"Not/A)Brand";v="99", "Chromium";v="148"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };

  return {
    DEFAULT_HEADERS,
    getBrowserHeaders(extra = {}) {
      return { ...DEFAULT_HEADERS, ...extra };
    },
  };
})();
