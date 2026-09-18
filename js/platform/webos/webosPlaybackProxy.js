import { requestWebOsCompanionService } from "./webosCompanionService.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "range",
  "transfer-encoding"
]);
const WEBOS_PLAYBACK_PROXY_TIMEOUT_MS = 5000;
const WEBOS_MEDIA_RESOLVE_TIMEOUT_MS = 32000;

function normalizeHeaderEntries(headers = {}) {
  if (!headers || typeof headers !== "object") {
    return [];
  }
  return Object.entries(headers)
    .map(([key, value]) => [String(key || "").trim(), String(value ?? "").trim()])
    .filter(([key, value]) => key && value)
    .filter(([key]) => !HOP_BY_HOP_HEADERS.has(key.toLowerCase()))
    .filter(
      ([key, value]) =>
        !key.includes("\r") && !key.includes("\n") && !value.includes("\r") && !value.includes("\n")
    );
}

function parseHttpUrl(value = "") {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

function isLocalProxyUrl(value = "") {
  const parsed = parseHttpUrl(value);
  if (!parsed || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    return false;
  }
  return parsed.pathname.startsWith("/proxy/");
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId = 0;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export function hasWebOsPlaybackHeaders(headers = {}) {
  return normalizeHeaderEntries(headers).length > 0;
}

export function buildWebOsPlaybackProxyUrl(baseUrl, sourceUrl, headers = {}) {
  const base = parseHttpUrl(baseUrl);
  const source = parseHttpUrl(sourceUrl);
  const entries = normalizeHeaderEntries(headers);
  if (!base || !source) {
    return "";
  }

  const options = new URLSearchParams();
  options.set("d", `${source.protocol}//${source.host}`);
  entries.forEach(([key, value]) => {
    // The webOS media proxy decodes the route options once before parsing
    // them as a query string. Encode the header value here as an additional
    // layer so reserved characters from a legitimate header value (notably
    // `&d=` inside an embed Referer) remain part of `h` after that parse.
    options.append("h", `${key}:${encodeURIComponent(value)}`);
  });

  const root = `${base.protocol}//${base.host}`.replace(/\/+$/, "");
  return `${root}/proxy/${options.toString()}${source.pathname || "/"}${source.search}`;
}

export const WebOsPlaybackProxy = {
  requiresProxy(sourceUrl = "", headers = {}, { force = false } = {}) {
    return Boolean(
      parseHttpUrl(sourceUrl) &&
        !isLocalProxyUrl(sourceUrl) &&
        (force || hasWebOsPlaybackHeaders(headers))
    );
  },

  async resolve(sourceUrl = "", headers = {}, { force = false } = {}) {
    const originalUrl = String(sourceUrl || "").trim();
    if (!this.requiresProxy(originalUrl, headers, { force })) {
      return { status: "not-required", url: originalUrl, proxied: false };
    }

    let service;
    try {
      service = await withTimeout(
        requestWebOsCompanionService({ method: "ping", parameters: {} }),
        WEBOS_PLAYBACK_PROXY_TIMEOUT_MS,
        "webOS playback proxy service timed out"
      );
    } catch (error) {
      return {
        status: "unavailable",
        url: originalUrl,
        proxied: false,
        detail: error?.message || String(error || "webOS playback proxy service unavailable")
      };
    }

    const payload = service?.payload || {};
    const baseUrl = String(payload.url || "").trim();
    if (payload.returnValue === false || !payload.settingsReachable || !baseUrl) {
      return {
        status: "unavailable",
        url: originalUrl,
        proxied: false,
        detail: payload.errorText || "webOS playback proxy service unavailable"
      };
    }

    const headerEntries = normalizeHeaderEntries(headers);
    let upstreamUrl = originalUrl;
    let resolvedContentType = "";
    let resolvedStatusCode = 0;
    let redirectChain = [];

    // AIOStreams-style /playback endpoints are GET-only redirect resolvers.
    // LG's native media pipeline can reject a localhost proxy that still points
    // at that resolver (notably when HEAD is rejected or the redirect target is
    // an opaque MKV CDN URL). Resolve only forced progressive sources that do
    // not depend on custom request headers; header-dependent streams keep the
    // existing proxy path untouched.
    if (force && !headerEntries.length) {
      try {
        const resolved = await withTimeout(
          requestWebOsCompanionService({
            method: "mediaResolve",
            parameters: { url: originalUrl, headers: {} },
            timeoutMs: WEBOS_MEDIA_RESOLVE_TIMEOUT_MS,
            retryOnFailure: false
          }),
          WEBOS_MEDIA_RESOLVE_TIMEOUT_MS + 1000,
          "webOS media URL resolution timed out"
        );
        const resolvedPayload = resolved?.payload || {};
        const candidate = String(resolvedPayload.url || "").trim();
        if (
          resolvedPayload.returnValue !== false &&
          candidate &&
          parseHttpUrl(candidate) &&
          !isLocalProxyUrl(candidate)
        ) {
          upstreamUrl = candidate;
          resolvedContentType = String(resolvedPayload.contentType || "").trim();
          resolvedStatusCode = Number(resolvedPayload.statusCode || 0);
          redirectChain = Array.isArray(resolvedPayload.redirectChain)
            ? resolvedPayload.redirectChain
            : [];
        }
      } catch (_) {
        // Fail open: the existing playback proxy remains the fallback.
      }
    }

    const proxyUrl = buildWebOsPlaybackProxyUrl(baseUrl, upstreamUrl, headers);
    if (!proxyUrl) {
      return {
        status: "unavailable",
        url: originalUrl,
        proxied: false,
        detail: "webOS playback proxy URL could not be built"
      };
    }

    return {
      status: "success",
      url: proxyUrl,
      proxied: true,
      baseUrl,
      originalUrl,
      upstreamUrl,
      resolvedContentType,
      resolvedStatusCode,
      redirectChain,
      headerNames: headerEntries.map(([key]) => key)
    };
  }
};
