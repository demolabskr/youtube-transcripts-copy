// background.js (서비스 워커)
// content.js 로부터 { type: "GET_TRANSCRIPT", videoId } 메시지를 받아
// 해당 영상의 자막(트랜스크립트) 전체 텍스트를 추출하여 돌려줍니다.

/**
 * 주어진 텍스트에서 marker(예: "ytInitialPlayerResponse = ") 뒤에 나오는
 * 첫 번째 '{' 부터 시작하여 중괄호 깊이를 세면서 균형 잡힌 JSON 객체를 추출합니다.
 * 문자열 리터럴(" ... ") 내부의 중괄호는 무시하고, 이스케이프(\)도 올바르게 처리합니다.
 *
 * @param {string} text  - 전체 HTML 텍스트
 * @param {string} marker - 객체 시작 직전의 마커 문자열
 * @returns {object} JSON.parse 된 객체
 */
function extractJSONObject(text, marker) {
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error("페이지에서 플레이어 데이터를 찾을 수 없습니다.");
  }

  // marker 이후에서 첫 번째 '{' 위치 찾기
  let start = text.indexOf("{", markerIdx + marker.length);
  if (start === -1) {
    throw new Error("플레이어 데이터의 JSON 시작 위치를 찾을 수 없습니다.");
  }

  let depth = 0;        // 중괄호 깊이
  let inString = false; // 문자열 리터럴 내부 여부
  let escaped = false;  // 직전 문자가 이스케이프(\)였는지

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        // 이스케이프된 문자이므로 그냥 통과
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // 문자열 밖
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // 균형 잡힌 객체 종료
        const jsonStr = text.slice(start, i + 1);
        return JSON.parse(jsonStr);
      }
    }
  }

  throw new Error("플레이어 데이터 JSON의 끝을 찾을 수 없습니다.");
}

/**
 * 간단한 HTML 엔티티 디코더 (XML 자막 폴백용).
 * @param {string} str
 * @returns {string}
 */
function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // 숫자형 엔티티 (10진수)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    // 숫자형 엔티티 (16진수)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * json3 포맷 자막 파싱: events 배열의 각 event 의 segs[].utf8 를 합칩니다.
 * @param {object} data - json3 파싱된 객체
 * @returns {string}
 */
function parseJson3(data) {
  if (!data || !Array.isArray(data.events)) return "";
  const lines = [];
  for (const ev of data.events) {
    if (!ev.segs || !Array.isArray(ev.segs)) continue; // segs 없는 이벤트는 건너뜀
    const line = ev.segs.map((seg) => seg.utf8 || "").join("");
    lines.push(line);
  }
  return lines.join("\n").trim();
}

/**
 * XML 자막 파싱 폴백: <text ...>...</text> 항목들을 추출 후 엔티티 디코드.
 * @param {string} xml
 * @returns {string}
 */
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

function describeError(err) {
  return err && err.message ? err.message : String(err);
}

function youtubeClientHeaders({
  clientName,
  clientVersion,
  visitorData,
  videoId,
} = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Origin": "https://www.youtube.com",
    "X-Goog-AuthUser": "0",
  };

  if (clientName) headers["X-YouTube-Client-Name"] = String(clientName);
  if (clientVersion) headers["X-YouTube-Client-Version"] = clientVersion;
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
  if (videoId) {
    headers["Referer"] = `https://www.youtube.com/watch?v=${encodeURIComponent(
      videoId
    )}`;
    headers["Origin"] = "https://www.youtube.com";
  }

  return headers;
}

/**
 * captionTracks 배열에서 선호하는 트랙을 선택합니다.
 * 우선순위: languageCode 가 "ko" 로 시작 > 수동 자막(kind !== "asr") > 첫 번째
 * @param {Array} tracks
 * @returns {object}
 */
function pickTrack(tracks) {
  // 1) 한국어(ko*) 트랙 우선
  const ko = tracks.find(
    (t) => typeof t.languageCode === "string" && t.languageCode.startsWith("ko")
  );
  if (ko) return ko;

  // 2) 자동 생성(asr) 이 아닌 수동 자막 우선
  const manual = tracks.find((t) => t.kind !== "asr");
  if (manual) return manual;

  // 3) 첫 번째
  return tracks[0];
}

function orderTracks(tracks) {
  if (!Array.isArray(tracks)) return [];
  const picked = pickTrack(tracks);
  const ordered = [];
  if (picked) ordered.push(picked);
  for (const track of tracks) {
    if (track !== picked) ordered.push(track);
  }
  return ordered;
}

function addOrReplaceQueryParam(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

async function fetchTrackTranscript(track) {
  if (!track || !track.baseUrl) return "";

  const urls = [
    addOrReplaceQueryParam(track.baseUrl, "fmt", "json3"),
    addOrReplaceQueryParam(track.baseUrl, "fmt", "srv3"),
    track.baseUrl,
  ];
  const credentialModes = ["omit", "include"];

  for (const url of urls) {
    for (const credentials of credentialModes) {
      try {
        const res = await fetch(url, { credentials });
        if (!res.ok) continue;

        const body = await res.text();
        if (!body.trim()) {
          continue;
        }

        let transcript = "";
        try {
          transcript = parseJson3(JSON.parse(body));
        } catch (e) {
          transcript = parseXmlCaptions(body);
        }

        if (transcript) return transcript;
      } catch (e) {
        // Try the next available credential mode/track/format.
      }
    }
  }

  return "";
}

async function fetchTranscriptFromTracks(tracks) {
  for (const track of orderTracks(tracks)) {
    const transcript = await fetchTrackTranscript(track);
    if (transcript) return transcript;
  }

  return "";
}

/**
 * 객체 트리에서 특정 key 를 가진 모든 값을 재귀적으로 수집합니다.
 * (InnerTube 응답 구조가 자주 바뀌므로 구조에 덜 의존하도록 깊이 탐색)
 * @param {*} obj
 * @param {string} key
 * @param {Array} acc
 * @returns {Array}
 */
function deepFindAll(obj, key, acc = []) {
  if (!obj || typeof obj !== "object") return acc;
  if (Array.isArray(obj)) {
    for (const item of obj) deepFindAll(item, key, acc);
    return acc;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) acc.push(obj[k]);
    const v = obj[k];
    if (v && typeof v === "object") deepFindAll(v, key, acc);
  }
  return acc;
}

function deepFindFirst(obj, key) {
  const all = deepFindAll(obj, key);
  return all.length ? all[0] : undefined;
}

/**
 * watch 페이지 HTML 에서 InnerTube 호출에 필요한 값들을 추출합니다.
 * @param {string} html
 * @returns {{apiKey:string, clientVersion:string, visitorData:string|null}}
 */
function extractInnerTubeConfig(html) {
  const apiKey =
    (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] ||
    "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // WEB 공개 키 (수년째 안정적)
  const clientVersion =
    (html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) || [])[1] ||
    (html.match(/"clientVersion":"([\d.]+)"/) || [])[1] ||
    "2.20240101.00.00";
  const visitorData =
    (html.match(/"visitorData":"([^"]+)"/) || [])[1] || null;
  return { apiKey, clientVersion, visitorData };
}

/**
 * InnerTube get_transcript API 로 트랜스크립트를 가져옵니다.
 * timedtext(baseUrl) 가 pot 토큰 요구로 빈 응답을 주는 문제를 우회합니다.
 * watch 페이지의 "스크립트 표시" 버튼이 쓰는 것과 동일한 경로입니다.
 * @param {string} videoId
 * @param {object} cfg - extractInnerTubeConfig 결과
 * @returns {Promise<string>}
 */
async function getTranscriptViaAndroidPlayer(videoId, cfg, credentials = "omit") {
  const { apiKey, visitorData } = cfg;
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
    {
      method: "POST",
      credentials,
      headers: youtubeClientHeaders({
        clientName: 3,
        clientVersion: "20.10.38",
        visitorData,
        videoId,
      }),
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
          },
        },
        videoId,
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`player API error (HTTP ${res.status})`);
  }

  const data = await res.json();
  const status = data?.playabilityStatus?.status;
  if (status && status !== "OK") {
    throw new Error(
      data?.playabilityStatus?.reason || `Video is not playable: ${status}`
    );
  }

  const tracks =
    data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) return "";

  return fetchTranscriptFromTracks(tracks);
}

async function getTranscriptViaInnerTube(videoId, cfg) {
  const { apiKey, clientVersion, visitorData } = cfg;
  const context = {
    client: { clientName: "WEB", clientVersion, hl: "ko" },
  };
  if (visitorData) context.client.visitorData = visitorData;

  const headers = youtubeClientHeaders({
    clientName: 1,
    clientVersion,
    visitorData,
    videoId,
  });

  // 1) next 호출 → 트랜스크립트 패널의 params(continuation 토큰) 확보
  const nextRes = await fetch(
    `https://www.youtube.com/youtubei/v1/next?key=${apiKey}&prettyPrint=false`,
    {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, videoId }),
    }
  );
  if (!nextRes.ok) {
    throw new Error(`next API 오류 (HTTP ${nextRes.status})`);
  }
  const nextData = await nextRes.json();
  const transcriptEndpoint = deepFindFirst(nextData, "getTranscriptEndpoint");
  const params = transcriptEndpoint && transcriptEndpoint.params;
  if (!params) {
    // 자막/트랜스크립트 패널이 없음
    return "";
  }

  // 2) get_transcript 호출
  const tRes = await fetch(
    `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`,
    {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, params }),
    }
  );
  if (!tRes.ok) {
    throw new Error(`get_transcript API 오류 (HTTP ${tRes.status})`);
  }
  const tData = await tRes.json();

  // 3) transcriptSegmentRenderer 들에서 텍스트 추출
  const segments = deepFindAll(tData, "transcriptSegmentRenderer");
  const lines = [];
  for (const seg of segments) {
    const snippet = seg && seg.snippet;
    if (!snippet) continue;
    let text = "";
    if (typeof snippet.simpleText === "string") {
      text = snippet.simpleText;
    } else if (Array.isArray(snippet.runs)) {
      text = snippet.runs.map((r) => r.text || "").join("");
    }
    text = text.trim();
    if (text) lines.push(text);
  }
  return lines.join("\n").trim();
}

/**
 * (폴백) timedtext baseUrl 로 자막을 가져옵니다. 최근에는 pot 토큰 요구로
 * 빈 응답을 주는 경우가 많지만, 일부 영상에서는 여전히 동작합니다.
 * @param {string} html - watch 페이지 HTML
 * @returns {Promise<string>}
 */
async function getTranscriptViaTimedText(html) {
  let player;
  try {
    player = extractJSONObject(html, "ytInitialPlayerResponse = ");
  } catch (e) {
    player = extractJSONObject(html, "ytInitialPlayerResponse =");
  }
  const tracks =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) return "";

  return fetchTranscriptFromTracks(tracks);
}

/**
 * 핵심 로직: videoId 로부터 트랜스크립트 텍스트를 가져옵니다.
 * @param {string} videoId
 * @returns {Promise<string>}
 */
async function getTranscript(videoId) {
  if (!videoId) {
    throw new Error("영상 ID를 확인할 수 없습니다.");
  }

  // 1) watch 페이지 HTML 가져오기 (로그인 쿠키 포함) — 설정값/자막 존재 확인용
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(
    videoId
  )}`;
  const res = await fetch(watchUrl, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`영상 페이지를 불러오지 못했습니다. (HTTP ${res.status})`);
  }
  const html = await res.text();
  const cfg = extractInnerTubeConfig(html);

  // 2) InnerTube get_transcript 우선 시도 (pot 토큰 문제 우회)
  let transcript = "";
  const failures = [];
  try {
    transcript = await getTranscriptViaAndroidPlayer(videoId, cfg, "omit");
  } catch (e) {
    failures.push("android-omit: " + describeError(e));
    transcript = "";
  }

  try {
    if (!transcript) {
      transcript = await getTranscriptViaAndroidPlayer(videoId, cfg, "include");
    }
  } catch (e) {
    failures.push("android-include: " + describeError(e));
    transcript = "";
  }

  try {
    if (!transcript) {
      transcript = await getTranscriptViaInnerTube(videoId, cfg);
    }
  } catch (e) {
    failures.push("web-transcript: " + describeError(e));
    transcript = "";
  }

  // 3) 폴백: 기존 timedtext 방식
  try {
    if (!transcript) {
      transcript = await getTranscriptViaTimedText(html);
    }
  } catch (e) {
    failures.push("web-timedtext: " + describeError(e));
    transcript = "";
  }

  if (!transcript) {
    throw new Error(
      "자막 내용을 가져오지 못했습니다. 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요." +
        (failures.length ? " 상세: " + failures.join(" / ") : "")
    );
  }

  if (!transcript) {
    throw new Error(
      "자막 내용을 가져오지 못했습니다. (이 영상에 자막이 없거나, YouTube 로그인이 필요할 수 있습니다.)"
    );
  }

  return transcript;
}

// 메시지 리스너: 비동기 응답을 위해 반드시 true 를 반환해 채널을 열어둡니다.
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingOffscreenDocument = null;

async function hasOffscreenDocument() {
  if (!chrome.offscreen) return false;
  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const matchedClients = await self.clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    throw new Error("Offscreen API is unavailable.");
  }

  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["CLIPBOARD"],
        justification: "Copy the fetched transcript text to the clipboard.",
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }

  await creatingOffscreenDocument;
}

async function copyTextToClipboard(text) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("No text to copy.");
  }

  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: "offscreen", type: "COPY_TO_CLIPBOARD", text },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.ok) {
          resolve();
          return;
        }
        reject(
          new Error(
            response && response.error
              ? response.error
              : "Offscreen clipboard copy failed."
          )
        );
      }
    );
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    !message ||
    message.target === "offscreen" ||
    (message.type !== "GET_TRANSCRIPT" && message.type !== "COPY_TO_CLIPBOARD")
  ) {
    return; // 우리가 처리할 메시지가 아님
  }

  // 비동기 처리: 항상 sendResponse 를 호출하도록 try/catch 로 감쌈
  if (message.type === "COPY_TO_CLIPBOARD") {
    (async () => {
      try {
        await copyTextToClipboard(message.text);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      }
    })();

    return true;
  }

  (async () => {
    try {
      const transcript = await getTranscript(message.videoId);
      sendResponse({ ok: true, transcript });
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();

  return true; // 채널 유지 (중요!)
});
