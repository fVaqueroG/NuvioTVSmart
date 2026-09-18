var http = require("http");
var https = require("https");
var net = require("net");
var URL = require("url").URL;

var MAX_REDIRECTS = 5;
var REQUEST_TIMEOUT_MS = 30000;
var HOP_BY_HOP_HEADERS = {
  connection: true,
  "content-length": true,
  host: true,
  range: true,
  "transfer-encoding": true
};

function isPrivateIpLiteral(hostname) {
  var host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  var family = net.isIP(host);
  if (!family) return false;
  if (family === 4) {
    var parts = host.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
  }
  return (
    host === "::1" ||
    host.indexOf("fc") === 0 ||
    host.indexOf("fd") === 0 ||
    host.indexOf("fe8") === 0 ||
    host.indexOf("fe9") === 0 ||
    host.indexOf("fea") === 0 ||
    host.indexOf("feb") === 0
  );
}

function parseRemoteHttpUrl(value) {
  var parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  var host = String(parsed.hostname || "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || isPrivateIpLiteral(host)) {
    return null;
  }
  return parsed;
}

function sanitizeHeaders(headers) {
  var output = {};
  Object.keys(headers || {}).forEach(function (name) {
    var key = String(name || "").trim();
    var lower = key.toLowerCase();
    var value = headers[name];
    if (!key || value == null || HOP_BY_HOP_HEADERS[lower]) return;
    var text = String(value);
    if (key.indexOf("\r") >= 0 || key.indexOf("\n") >= 0 || text.indexOf("\r") >= 0 || text.indexOf("\n") >= 0) {
      return;
    }
    output[key] = text;
  });
  output.Range = "bytes=0-0";
  if (!output.Accept && !output.accept) output.Accept = "*/*";
  if (!output["User-Agent"] && !output["user-agent"]) {
    output["User-Agent"] = "Mozilla/5.0 (webOS; NuvioTV) AppleWebKit/537.36";
  }
  return output;
}

function headersForRedirect(headers, fromUrl, toUrl) {
  var next = Object.assign({}, headers || {});
  if (fromUrl.origin !== toUrl.origin) {
    Object.keys(next).forEach(function (name) {
      var lower = String(name || "").toLowerCase();
      if (lower === "authorization" || lower === "cookie" || lower === "proxy-authorization") {
        delete next[name];
      }
    });
  }
  return next;
}

function resolveRemoteMediaUrl(rawUrl, headers, callback, redirectsLeft, chain) {
  var parsed = parseRemoteHttpUrl(rawUrl);
  if (!parsed) {
    callback(new Error("Unsupported or local media URL"));
    return;
  }

  var remaining = Number.isFinite(Number(redirectsLeft))
    ? Number(redirectsLeft)
    : MAX_REDIRECTS;
  var redirectChain = Array.isArray(chain) ? chain.slice() : [parsed.toString()];
  var requestHeaders = sanitizeHeaders(headers);
  var transport = parsed.protocol === "http:" ? http : https;
  var settled = false;
  var request = transport.request(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: requestHeaders
    },
    function (response) {
      var statusCode = Number(response.statusCode || 0);
      var location = response.headers && response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (remaining <= 0) {
          settled = true;
          callback(new Error("Media redirect limit reached"));
          return;
        }
        var nextUrl;
        try {
          nextUrl = new URL(location, parsed.toString());
        } catch (error) {
          settled = true;
          callback(error);
          return;
        }
        var nextHeaders = headersForRedirect(headers || {}, parsed, nextUrl);
        settled = true;
        resolveRemoteMediaUrl(
          nextUrl.toString(),
          nextHeaders,
          callback,
          remaining - 1,
          redirectChain.concat(nextUrl.toString())
        );
        return;
      }

      settled = true;
      callback(null, {
        url: parsed.toString(),
        statusCode: statusCode,
        contentType: String((response.headers && response.headers["content-type"]) || ""),
        contentLength: String((response.headers && response.headers["content-length"]) || ""),
        contentRange: String((response.headers && response.headers["content-range"]) || ""),
        acceptRanges: String((response.headers && response.headers["accept-ranges"]) || ""),
        contentDisposition: String(
          (response.headers && response.headers["content-disposition"]) || ""
        ),
        redirectChain: redirectChain
      });

      // We only need the final response headers. Do not download the media body.
      response.destroy();
    }
  );

  request.setTimeout(REQUEST_TIMEOUT_MS, function () {
    request.destroy(new Error("Media URL resolution timed out"));
  });
  request.on("error", function (error) {
    if (!settled) {
      settled = true;
      callback(error);
    }
  });
  request.end();
}

module.exports = {
  MAX_REDIRECTS: MAX_REDIRECTS,
  parseRemoteHttpUrl: parseRemoteHttpUrl,
  resolveRemoteMediaUrl: resolveRemoteMediaUrl,
  sanitizeHeaders: sanitizeHeaders
};
