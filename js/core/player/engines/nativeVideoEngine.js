function isWebOsRuntime() {
  try {
    if (globalThis.webOSSystem || globalThis.PalmSystem || globalThis.webOSDev) {
      return true;
    }
    const ua = String(globalThis.navigator?.userAgent || "").toLowerCase();
    return ua.includes("webos") || ua.includes("web0s");
  } catch (_) {
    return false;
  }
}

function stageWebOsLoad(videoElement) {
  const token = Number(videoElement.__nuvioNativeLoadToken || 0) + 1;
  videoElement.__nuvioNativeLoadToken = token;

  const startedAt = Date.now();
  const timeoutMs = 1500;
  const intervalMs = 50;

  const tryLoad = () => {
    if (Number(videoElement.__nuvioNativeLoadToken || 0) !== token) {
      return;
    }

    const mediaId = String(videoElement.mediaId || "").trim();
    if (mediaId || Date.now() - startedAt >= timeoutMs) {
      try {
        videoElement.load();
      } catch (_) {
        // The controller will surface the native playback error if load fails.
      }
      return;
    }

    setTimeout(tryLoad, intervalMs);
  };

  tryLoad();
}

export const nativeVideoEngine = {
  name: "native",

  canPlay(videoElement, mimeType) {
    if (!videoElement || !mimeType) {
      return false;
    }
    try {
      const result = String(videoElement.canPlayType(String(mimeType))).toLowerCase();
      return result === "probably" || result === "maybe";
    } catch (_) {
      return false;
    }
  },

  load(videoElement, url, mimeType = null) {
    if (!videoElement) {
      return false;
    }

    videoElement.__nuvioNativeLoadToken = Number(videoElement.__nuvioNativeLoadToken || 0) + 1;
    videoElement.removeAttribute("src");
    Array.from(videoElement.querySelectorAll("source")).forEach((node) => node.remove());

    if (isWebOsRuntime()) {
      // LG's native media pipeline publishes video.mediaId asynchronously.
      // Loading immediately after setting src can race that registration and
      // leave the element at readyState=0/networkState=3. Use a direct src and
      // wait briefly for mediaId before calling load(), matching the staged
      // startup path used elsewhere in the webOS player.
      videoElement.src = url;
      stageWebOsLoad(videoElement);
      return true;
    }

    if (mimeType) {
      const sourceNode = document.createElement("source");
      sourceNode.src = url;
      sourceNode.type = mimeType;
      videoElement.appendChild(sourceNode);
    } else {
      videoElement.src = url;
    }
    videoElement.load();
    return true;
  }
};
