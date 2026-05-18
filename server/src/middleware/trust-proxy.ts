// Parsed value compatible with Express's `app.set("trust proxy", ...)`.
// See https://expressjs.com/en/guide/behind-proxies.html
export type TrustProxyValue = boolean | number | string;

// Read PAPERCLIP_TRUST_PROXY and turn it into an Express-compatible trust value.
// Defaults to `false` (no proxy trust) so that headers like X-Forwarded-Host
// cannot be spoofed by an arbitrary client when the runtime is exposed beyond
// loopback (e.g. tailnet, LAN). Supported forms:
//   - unset / "" / "false" / "0"      -> false
//   - "true" / "1"                    -> true (trust everything; only safe behind a real proxy)
//   - integer >= 0                    -> hop count
//   - other string                    -> passed through (named token like
//                                        "loopback", "linklocal", "uniquelocal",
//                                        or comma-separated subnets)
export function parseTrustProxy(raw: string | undefined): TrustProxyValue {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const lower = trimmed.toLowerCase();
  if (lower === "false" || lower === "0") return false;
  if (lower === "true") return true;
  if (/^\d+$/.test(trimmed)) {
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && asNum >= 0) return asNum;
  }
  return trimmed;
}

// True when the configured trust value would cause Express (and our guards)
// to honour X-Forwarded-* headers. A hop count of 0 means "no trusted proxies".
export function isTrustProxyEnabled(value: TrustProxyValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return value.length > 0;
}
