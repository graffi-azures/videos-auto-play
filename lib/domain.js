/* Shared domain helpers — loaded in background, sidebar, and content contexts. */

function normalizeDomain(input) {
  if (!input || typeof input !== "string") return "";
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainMatchesUrl(domain, url) {
  const target = normalizeDomain(domain);
  if (!target) return false;
  const host = hostnameFromUrl(url);
  if (!host) return false;
  return host === target || host.endsWith("." + target);
}
