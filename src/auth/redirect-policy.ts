/**
 * Open-DCR redirect_uri policy (review F-09).
 *
 * Before v0.0.17 `/register` signed whatever `redirect_uris` a caller sent
 * and `/authorize` auto-approves, so any registrant could turn the
 * connector's trusted origin into a 302 to an arbitrary site (phishing /
 * link laundering) — on success with a code and on every phase-2 error.
 * The connector now accepts only redirect targets a legitimate MCP client
 * can have:
 *
 *   - Anthropic's callback URIs (`DEFAULT_ANTHROPIC_REDIRECT_URIS`), exactly;
 *   - loopback http / https on 127.0.0.1, [::1] or localhost, any port and
 *     path (RFC 8252 §7.3 — native and CLI clients bind an ephemeral port);
 *   - private-use custom schemes (RFC 8252 §7.1, e.g. `com.example.app:/cb`)
 *     except the deny-list (`deniedSchemeReason`): schemes a browser treats
 *     as script, a local file, another network protocol or a browser page,
 *     AND the operating-system / browser protocol handlers that are not
 *     app callbacks but launchers — `ms-excel:ofe|u|https://evil/x.xlsx`,
 *     `search-ms:…location:\\evil@SSL\s`, `itms-services://…`,
 *     `view-source:`, `intent://`, `mailto:`, `web+…` and the like. Each of
 *     those turned a 302 from this origin into "open Excel on a remote
 *     workbook" or "browse an attacker's share" with the connector's
 *     domain shown as the requester (review round 1, F-09 residual). A
 *     deny-list cannot be complete; it covers the handler families known
 *     to fetch remote content, run tools or address other people, and the
 *     prefixes (`ms-`, `web+`, `chrome-`, …) cover whole vendor families.
 *   - https on an operator-listed host (`MCP_OAUTH_REDIRECT_HOSTS`, exact
 *     hostnames; the literal `*` allows any https host and RE-OPENS F-09).
 *
 * Plus shape rules for every URI: ≤ 512 chars, ≤ 10 per client, no
 * fragment (RFC 6749 §3.1.2), no userinfo (`https://claude.ai@evil/`
 * look-alikes), no whitespace / control characters / backslash (the WHATWG
 * parser rewrites those, so what is checked would not be what the browser
 * follows).
 *
 * The SAME check runs when a signed client_id is used (`getClient`), not
 * only at registration: client_ids are stateless blobs, so a blob signed
 * by v0.0.16 with an evil redirect would otherwise keep working forever.
 * Such legacy clients now resolve to "unknown client" (400 at /authorize,
 * no redirect) and must re-register. Static-client mode does not use this
 * policy — the operator sets its URIs (MCP_OAUTH_REDIRECT_URIS).
 */

// claude.com: Anthropic's connector guidance announces that the callback
// "may change to https://claude.com/api/mcp/auth_callback" and asks
// allow-list keepers to add it now. v0.0.16 accepted any https callback,
// so without this line the day Claude starts registering it (alone or next
// to claude.ai — one refused URI refuses the whole registration) every new
// Claude connection to an open-DCR deployment would fail at /register.
// Still an exact match on an Anthropic-controlled origin.
export const DEFAULT_ANTHROPIC_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.ai/api/oauth/callback",
  "https://claude.ai/oauth/callback",
  "https://claude.com/api/mcp/auth_callback",
];

export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_CHARS = 512;

// Same set the SDK's RFC 8252 port relaxation honours (authorize.js), so a
// URI allowed here is also one the SDK will match on any port.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

// http/https are decided by the host rules above, never by scheme alone.
// Exact schemes (lower-case, as `URL.protocol` yields them) that are never
// an OAuth callback: script / document / local-file schemes, other network
// protocols (which a browser hands to an OS client — SMB and WebDAV shares,
// LDAP, SSH, telnet …), messaging handlers that address third parties, app
// stores and package installers, and the browser-internal pages.
const DENIED_SCHEMES = new Set([
  "http:",
  "https:",
  // script, documents, local data
  "javascript:",
  "livescript:",
  "vbscript:",
  "data:",
  "blob:",
  "file:",
  "filesystem:",
  "about:",
  "view-source:",
  "jar:",
  "mhtml:",
  "mk:",
  "its:",
  "cid:",
  "mid:",
  "res:",
  "resource:",
  "wyciwyg:",
  // other network protocols and remote shares
  "ftp:",
  "ftps:",
  "sftp:",
  "ws:",
  "wss:",
  "smb:",
  "cifs:",
  "nfs:",
  "afp:",
  "dav:",
  "webdav:",
  "ldap:",
  "ldaps:",
  "ssh:",
  "telnet:",
  "rlogin:",
  "tn3270:",
  "gopher:",
  "news:",
  "nntp:",
  "snews:",
  "irc:",
  "ircs:",
  "irc6:",
  "rdp:",
  "vnc:",
  "git:",
  "svn:",
  "magnet:",
  "ed2k:",
  // OS shell, search and help handlers (Windows, macOS, Android)
  "shell:",
  "search:",
  "search-ms:",
  "hcp:",
  "help:",
  "jnlp:",
  "jnlps:",
  "intent:",
  "android-app:",
  "market:",
  "applescript:",
  "x-apple-helpbook:",
  "x-apple.systempreferences:",
  "itms:",
  "itms-apps:",
  "itms-appss:",
  "itms-services:",
  "itms-books:",
  "itms-bookss:",
  "macappstore:",
  "macappstores:",
  "microsoft-edge:",
  // messaging / calls to third parties
  "mailto:",
  "tel:",
  "sms:",
  "smsto:",
  "mms:",
  "callto:",
  "facetime:",
  "facetime-audio:",
  "sip:",
  "sips:",
  "skype:",
  "xmpp:",
  "im:",
  "geo:",
  // browser-internal pages
  "chrome:",
  "edge:",
  "opera:",
  "brave:",
  "vivaldi:",
  "firefox:",
]);

// Whole vendor / handler families, matched as scheme prefixes: Microsoft's
// `ms-*` launchers (`ms-excel`, `ms-word`, `ms-officecmd`, `ms-msdt`,
// `ms-settings`, `ms-appinstaller`, `ms-search`, …), browser extension and
// internal schemes, and `web+*` handlers a web page registered with
// `navigator.registerProtocolHandler` — which open a web page, i.e. an
// open redirect by another name.
const DENIED_SCHEME_PREFIXES = [
  "ms-",
  "web+",
  "chrome-",
  "edge-",
  "moz-",
  "opera-",
  "safari-",
  "x-apple-",
  "itms-",
];

/** Why a non-http(s) scheme is refused, or undefined when it may be a private-use app scheme. */
function deniedSchemeReason(protocol: string): string | undefined {
  if (DENIED_SCHEMES.has(protocol) || DENIED_SCHEME_PREFIXES.some((p) => protocol.startsWith(p))) {
    return `scheme ${protocol} is not allowed (not an app callback)`;
  }
  return undefined;
}

const ANTHROPIC_HREFS = new Set(DEFAULT_ANTHROPIC_REDIRECT_URIS.map((u) => new URL(u).href));

export interface RedirectPolicy {
  /** Exact https hostnames allowed beyond the built-ins, or "*" for any https host (re-opens F-09). */
  readonly httpsHosts: ReadonlySet<string> | "*";
}

export const DEFAULT_REDIRECT_POLICY: RedirectPolicy = { httpsHosts: new Set<string>() };

/** C0 controls, space, DEL or a backslash anywhere in the raw text. */
function hasUnsafeChar(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

/** Why `raw` is not an acceptable redirect URI under `policy`, or undefined when it is. */
export function redirectUriProblem(raw: string, policy: RedirectPolicy): string | undefined {
  if (raw.length > MAX_REDIRECT_URI_CHARS) return `longer than ${MAX_REDIRECT_URI_CHARS} chars`;
  if (hasUnsafeChar(raw)) return "contains whitespace, a control character or a backslash";
  // `new URL("https://x/#").hash` is "" — test the raw text, not the parse.
  if (raw.includes("#")) return "must not contain a fragment";
  if (!URL.canParse(raw)) return "is not a valid URL";
  const url = new URL(raw);
  // `https://@evil.example/` parses with an empty username; refuse any "@"
  // in the authority, not only a non-empty one.
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?]*@/i.test(raw)) {
    return "must not contain userinfo";
  }
  if (ANTHROPIC_HREFS.has(url.href)) return undefined;
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (LOOPBACK_HOSTS.has(url.hostname)) return undefined;
    if (url.protocol === "http:") {
      return "plain http is allowed only on loopback (127.0.0.1, [::1], localhost)";
    }
    const hosts = policy.httpsHosts;
    if (hosts === "*" || hosts.has(url.hostname)) return undefined;
    return "https host is not on this server's redirect allow-list";
  }
  return deniedSchemeReason(url.protocol);
}

/** Validate a client's whole redirect_uris list; undefined when acceptable. */
export function redirectUrisProblem(
  uris: readonly string[] | undefined,
  policy: RedirectPolicy,
): string | undefined {
  if (!uris || uris.length === 0) return "redirect_uris must contain at least one URI";
  if (uris.length > MAX_REDIRECT_URIS) {
    return `redirect_uris may contain at most ${MAX_REDIRECT_URIS} URIs`;
  }
  for (const [i, uri] of uris.entries()) {
    const problem = redirectUriProblem(uri, policy);
    // Index, not the URI itself: the value is caller-controlled.
    if (problem) return `redirect_uris[${i}] ${problem}`;
  }
  return undefined;
}

/**
 * Parse MCP_OAUTH_REDIRECT_HOSTS: comma-separated exact hostnames (no
 * scheme, port, path or wildcard label), or the single literal `*`.
 */
export function parseRedirectHosts(
  raw: string | undefined,
): { ok: RedirectPolicy } | { error: string } {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return { ok: DEFAULT_REDIRECT_POLICY };
  if (entries.includes("*")) {
    if (entries.length > 1) {
      return { error: "MCP_OAUTH_REDIRECT_HOSTS: `*` must be the only entry." };
    }
    return { ok: { httpsHosts: "*" } };
  }
  const hosts = new Set<string>();
  for (const entry of entries) {
    // Normalise through the URL parser (lower-case, punycode) so the entry
    // compares equal to what `new URL(redirect).hostname` yields — and refuse
    // anything that is not a bare hostname.
    const probe = `https://${entry}/`;
    const parsed = URL.canParse(probe) ? new URL(probe) : undefined;
    if (
      !parsed ||
      parsed.href !== `https://${parsed.hostname}/` ||
      parsed.hostname !== entry.toLowerCase() ||
      entry.includes("*")
    ) {
      return {
        error:
          "MCP_OAUTH_REDIRECT_HOSTS must be comma-separated bare hostnames " +
          `(e.g. vscode.dev,chatgpt.com) or the single value *; got ${JSON.stringify(entry.slice(0, 80))}.`,
      };
    }
    hosts.add(parsed.hostname);
  }
  return { ok: { httpsHosts: hosts } };
}

/** One-line description for the startup log. */
export function describeRedirectPolicy(policy: RedirectPolicy): string {
  const https =
    policy.httpsHosts === "*"
      ? "ANY https host"
      : policy.httpsHosts.size
        ? `https hosts ${[...policy.httpsHosts].join(",")}`
        : "no other https hosts";
  return `Anthropic callbacks, loopback http(s), private-use schemes, ${https}`;
}
