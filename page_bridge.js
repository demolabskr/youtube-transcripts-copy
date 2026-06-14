"use strict";

(() => {
  if (window.__ytTranscriptCopyBridgeInstalled) return;
  window.__ytTranscriptCopyBridgeInstalled = true;

  function decodeHTMLEntities(str) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = str;
    return textarea.value;
  }

  function parseJson3(data) {
    if (!data || !Array.isArray(data.events)) return "";
    const lines = [];
    for (const ev of data.events) {
      if (!Array.isArray(ev.segs)) continue;
      const line = ev.segs.map((seg) => seg.utf8 || "").join("").trim();
      if (line) lines.push(line);
    }
    return lines.join("\n").trim();
  }

  function parseXmlCaptions(xml) {
    const lines = [];
    const regex = /<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g;
    let m;
    while ((m = regex.exec(xml)) !== null) {
      const line = decodeHTMLEntities(m[1])
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (line) lines.push(line);
    }
    return lines.join("\n").trim();
  }

  function getYtcfgValue(key) {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") {
        const value = window.ytcfg.get(key);
        if (value) return value;
      }
    } catch (e) {
      // Fall through to regex extraction.
    }

    const html = document.documentElement.innerHTML;
    const match = html.match(new RegExp('"' + key + '":"([^"]+)"'));
    return match ? match[1] : null;
  }

  function orderTracks(tracks) {
    const ko = tracks.find(
      (t) => typeof t.languageCode === "string" && t.languageCode.startsWith("ko")
    );
    const manual = tracks.find((t) => t.kind !== "asr");
    const picked = ko || manual || tracks[0];
    return [picked, ...tracks.filter((track) => track !== picked)];
  }

  function setParam(url, key, value) {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  }

  async function fetchTrack(track) {
    const urls = [
      setParam(track.baseUrl, "fmt", "json3"),
      setParam(track.baseUrl, "fmt", "srv3"),
      track.baseUrl,
    ];

    for (const url of urls) {
      for (const credentials of ["include", "omit"]) {
        try {
          const res = await fetch(url, { credentials });
          if (!res.ok) continue;
          const body = await res.text();
          if (!body.trim()) continue;

          let transcript = "";
          try {
            transcript = parseJson3(JSON.parse(body));
          } catch (e) {
            transcript = parseXmlCaptions(body);
          }
          if (transcript) return transcript;
        } catch (e) {
          // Try the next mode.
        }
      }
    }

    return "";
  }

  async function getTranscript(videoId) {
    const apiKey = getYtcfgValue("INNERTUBE_API_KEY");
    if (!apiKey) throw new Error("Studio page API key not found.");

    const body = {
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "20.10.38",
        },
      },
      videoId,
    };

    const endpoints = [
      `/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
      `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
    ];

    const failures = [];
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          failures.push(`${endpoint}: HTTP ${res.status}`);
          continue;
        }

        const data = await res.json();
        const tracks =
          data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!tracks || tracks.length === 0) {
          failures.push(`${endpoint}: no caption tracks`);
          continue;
        }

        for (const track of orderTracks(tracks)) {
          const transcript = await fetchTrack(track);
          if (transcript) return transcript;
        }
        failures.push(`${endpoint}: caption tracks returned empty text`);
      } catch (e) {
        failures.push(`${endpoint}: ${e && e.message ? e.message : e}`);
      }
    }

    throw new Error(failures.join(" / "));
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== "yt-transcript-copy" ||
      event.data.type !== "GET_TRANSCRIPT_IN_PAGE"
    ) {
      return;
    }

    (async () => {
      try {
        const transcript = await getTranscript(event.data.videoId);
        window.postMessage(
          {
            source: "yt-transcript-copy-bridge",
            type: "GET_TRANSCRIPT_IN_PAGE_RESULT",
            requestId: event.data.requestId,
            ok: true,
            transcript,
          },
          "*"
        );
      } catch (err) {
        window.postMessage(
          {
            source: "yt-transcript-copy-bridge",
            type: "GET_TRANSCRIPT_IN_PAGE_RESULT",
            requestId: event.data.requestId,
            ok: false,
            error: err && err.message ? err.message : String(err),
          },
          "*"
        );
      }
    })();
  });
})();
