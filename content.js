// content.js
// YouTube 스튜디오(studio.youtube.com/video/*)는 SPA 이므로,
// URL 변경 및 DOM 변경을 감지하여 영상 편집 페이지에 '트랜스크립트 복사' 버튼을 주입합니다.

(() => {
  "use strict";

  const BTN_ID = "yt-transcript-copy-btn";

  /**
   * 현재 URL 의 pathname 에서 /video/<ID>/... 형태의 영상 ID 를 추출합니다.
   * @returns {string|null}
   */
  function getVideoIdFromUrl() {
    // 예: /video/51WXsJhOWrA/edit  또는  /video/51WXsJhOWrA/analytics
    const m = location.pathname.match(/\/video\/([^/]+)(?:\/|$)/);
    return m ? m[1] : null;
  }

  /**
   * 현재 페이지가 영상 편집(/video/<ID>/edit) 페이지인지 확인합니다.
   * @returns {boolean}
   */
  function isEditPage() {
    return /\/video\/[^/]+\/edit/.test(location.pathname);
  }

  /**
   * Shadow DOM 을 포함하여 문서 전체에서 셀렉터에 맞는 모든 요소를 찾습니다.
   * YouTube Studio 는 Polymer 기반이라 요소들이 중첩된 Shadow Root 안에 있습니다.
   * 일반 querySelectorAll 은 Shadow DOM 을 뚫지 못하므로 재귀적으로 탐색합니다.
   * @param {string} selector
   * @param {Document|ShadowRoot|Element} root
   * @param {HTMLElement[]} acc
   * @returns {HTMLElement[]}
   */
  function deepQueryAll(selector, root = document, acc = []) {
    // 현재 root 직속 매칭
    root.querySelectorAll(selector).forEach((el) => acc.push(el));
    // 모든 하위 요소를 돌면서 shadowRoot 가 있으면 그 안으로 재귀
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (el.shadowRoot) {
        deepQueryAll(selector, el.shadowRoot, acc);
      }
    }
    return acc;
  }

  /**
   * 영상 링크(워치/유튜브 링크) 요소를 Shadow DOM 까지 포함하여 찾습니다.
   * href 가 youtu.be / youtube.com/watch 링크처럼 보이는 첫 번째 요소를 반환합니다.
   * @returns {HTMLElement|null}
   */
  function findVideoLink() {
    const links = deepQueryAll("a[href]").filter((el) => {
      const href = el.getAttribute("href") || el.href || "";
      return /youtu\.be\//.test(href) || /youtube\.com\/watch/.test(href);
    });
    if (!links.length) return null;

    // 후보 중 가장 적합한 "동영상 링크" 를 점수로 선택.
    // - ytcp-video-info: 세부정보 화면의 실제 동영상 링크 텍스트 (최우선)
    // - overlay-link-to-youtube: 썸네일 위 오버레이 링크 → 제외해야 함
    // - youtu.be 단축 링크 가산점
    function score(el) {
      const cls = el.className || "";
      const id = el.id || "";
      const href = el.getAttribute("href") || el.href || "";
      let s = 0;
      if (/ytcp-video-info/.test(cls)) s += 100; // 진짜 동영상 링크
      if (/overlay/.test(cls) || /overlay-link-to-youtube/.test(id)) s -= 100; // 오버레이 제외
      if (/youtu\.be\//.test(href)) s += 10; // 단축 링크 선호
      return s;
    }

    let best = null;
    let bestScore = -Infinity;
    for (const el of links) {
      const sc = score(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
    // 점수가 음수뿐(오버레이만 존재)이라도 일단 반환하지 않고 null 처리
    return bestScore >= 0 ? best : null;
  }

  /**
   * 클립보드에 텍스트를 복사합니다. navigator.clipboard 가 실패하면
   * 숨겨진 textarea + execCommand('copy') 폴백을 사용합니다.
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // 포커스 문제 등으로 실패 시 폴백
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.select();
      try {
        const ok = document.execCommand("copy");
        if (!ok) throw new Error("execCommand copy 실패");
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  /**
   * 버튼 클릭 핸들러: 백그라운드에 트랜스크립트를 요청하고 클립보드에 복사합니다.
   * @param {MouseEvent} evt
   */
  async function copyToClipboardRobust(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (clipboardError) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "0";
        ta.style.width = "1px";
        ta.style.height = "1px";
        ta.style.opacity = "0";
        ta.style.pointerEvents = "none";
        ta.setAttribute("readonly", "");
        document.body.appendChild(ta);
        ta.focus({ preventScroll: true });
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        try {
          const ok = document.execCommand("copy");
          if (!ok) throw new Error("execCommand copy failed");
          return;
        } finally {
          document.body.removeChild(ta);
        }
      } catch (execCommandError) {
        await copyToClipboardViaBackground(
          text,
          execCommandError || clipboardError
        );
      }
    }
  }

  function copyToClipboardViaBackground(text, originalError) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "COPY_TO_CLIPBOARD", text },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(
              new Error(
                "background clipboard copy failed: " +
                  chrome.runtime.lastError.message +
                  " / local copy failed: " +
                  (originalError && originalError.message
                    ? originalError.message
                    : originalError)
              )
            );
            return;
          }
          if (response && response.ok) {
            resolve();
            return;
          }
          reject(
            new Error(
              (response && response.error
                ? response.error
                : "background clipboard copy failed") +
                " / local copy failed: " +
                (originalError && originalError.message
                  ? originalError.message
                  : originalError)
            )
          );
        }
      );
    });
  }

  let pageBridgePromise = null;

  function ensurePageBridge() {
    if (pageBridgePromise) return pageBridgePromise;

    pageBridgePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page_bridge.js");
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => {
        pageBridgePromise = null;
        script.remove();
        reject(new Error("page bridge script failed to load"));
      };
      (document.documentElement || document.head || document.body).appendChild(
        script
      );
    });

    return pageBridgePromise;
  }

  async function getTranscriptViaPageBridge(videoId) {
    await ensurePageBridge();

    return new Promise((resolve, reject) => {
      const requestId =
        Date.now().toString(36) + Math.random().toString(36).slice(2);
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("page bridge timed out"));
      }, 30000);

      function onMessage(event) {
        if (
          event.source !== window ||
          !event.data ||
          event.data.source !== "yt-transcript-copy-bridge" ||
          event.data.type !== "GET_TRANSCRIPT_IN_PAGE_RESULT" ||
          event.data.requestId !== requestId
        ) {
          return;
        }

        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        if (event.data.ok && event.data.transcript) {
          resolve(event.data.transcript);
        } else {
          reject(new Error(event.data.error || "page bridge failed"));
        }
      }

      window.addEventListener("message", onMessage);
      window.postMessage(
        {
          source: "yt-transcript-copy",
          type: "GET_TRANSCRIPT_IN_PAGE",
          requestId,
          videoId,
        },
        "*"
      );
    });
  }

  function cleanTranscriptLine(line) {
    let cleaned = String(line || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) return "";
    if (/^[\[\(（【]?\s*(music|applause|laughter|음악|박수|웃음|노래|효과음)\s*[\]\)）】]?$/i.test(cleaned)) {
      return "";
    }
    if (/^[\[\(（【][^\]\)）】]*(music|applause|laughter|음악|박수|웃음|노래|효과음)[^\]\)）】]*[\]\)）】]$/i.test(cleaned)) {
      return "";
    }

    cleaned = cleaned.replace(/[♪♫♬]+/g, "").trim();
    return cleaned;
  }

  function splitTranscriptSentences(text) {
    const sentences = [];
    let current = "";
    const strongEnd = /[.!?。？！…]/;
    const koreanSoftEnd =
      /(다|요|죠|니다|습니다|세요|네요|군요|까요|가요|나요|래요|예요|이에요)$/;

    for (const part of text.split(/\s+/)) {
      if (!part) continue;
      current = current ? current + " " + part : part;

      const trimmed = current.trim();
      const token = part.replace(/[)"'”’\]}]+$/g, "");
      if (
        strongEnd.test(token.slice(-1)) ||
        (trimmed.length >= 45 && koreanSoftEnd.test(token)) ||
        trimmed.length >= 120
      ) {
        sentences.push(trimmed);
        current = "";
      }
    }

    if (current.trim()) sentences.push(current.trim());
    return sentences;
  }

  function formatTranscriptForCopy(transcript) {
    const lines = String(transcript || "")
      .split(/\r?\n/)
      .map(cleanTranscriptLine)
      .filter(Boolean);

    if (!lines.length) return String(transcript || "").trim();

    const joined = lines
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.?!:;，。？！、])/g, "$1")
      .replace(/([([{“‘])\s+/g, "$1")
      .replace(/\s+([)\]}”’])/g, "$1")
      .trim();

    return splitTranscriptSentences(joined).join("\n").trim();
  }

  function onButtonClick(evt) {
    const btn = evt.currentTarget;
    const originalText = "📋 트랜스크립트 복사";

    btn.disabled = true;
    btn.textContent = "복사 중...";

    const videoId = getVideoIdFromUrl();
    if (!videoId) {
      btn.textContent = "❌ 실패";
      alert("영상 ID를 확인할 수 없습니다.");
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
      return;
    }

    chrome.runtime.sendMessage(
      { type: "GET_TRANSCRIPT", videoId },
      async (response) => {
        // 메시지 채널 오류 방어
        if (chrome.runtime.lastError) {
          btn.textContent = "❌ 실패";
          alert("확장 프로그램 통신 오류: " + chrome.runtime.lastError.message);
          setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
          }, 2000);
          return;
        }

        if (response && response.ok) {
          try {
            await copyToClipboardRobust(formatTranscriptForCopy(response.transcript));
            btn.textContent = "✅ 복사됨!";
          } catch (e) {
            btn.textContent = "❌ 실패";
            alert("클립보드 복사에 실패했습니다: " + (e.message || e));
          }
        } else {
          const msg = response && response.error ? response.error : "알 수 없는 오류";
          btn.textContent = "❌ 실패";
          try {
            btn.textContent = "페이지에서 재시도...";
            const transcript = await getTranscriptViaPageBridge(videoId);
            await copyToClipboardRobust(formatTranscriptForCopy(transcript));
            btn.textContent = "??蹂듭궗??";
          } catch (pageError) {
            btn.textContent = "???ㅽ뙣";
            alert(
              msg +
                "\n\n페이지 컨텍스트 재시도도 실패했습니다: " +
                (pageError && pageError.message ? pageError.message : pageError)
            );
          }
        }

        setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
        }, 2000);
      }
    );
  }

  /**
   * 버튼을 생성하여 영상 링크 바로 뒤에 주입합니다.
   * 이미 버튼이 있거나 링크를 찾지 못하면 아무 것도 하지 않습니다.
   */
  /**
   * 이미 주입된 버튼을 Shadow DOM 까지 포함하여 찾습니다.
   * document.getElementById 는 Shadow DOM 내부 요소를 찾지 못하기 때문에 필요합니다.
   * @returns {HTMLElement|null}
   */
  function findExistingButton() {
    const found = deepQueryAll("#" + BTN_ID);
    return found.length ? found[0] : null;
  }

  function injectButton() {
    // 이미 존재하면 중복 주입 방지 (Shadow DOM 포함 검사)
    if (findExistingButton()) return;

    const link = findVideoLink();
    if (!link || !link.parentNode) return; // 링크 없으면 주입하지 않음 (계속 관찰)

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "📋 트랜스크립트 복사";
    // 인라인 스타일
    btn.style.marginLeft = "8px";
    btn.style.padding = "4px 10px";
    btn.style.cursor = "pointer";
    btn.style.borderRadius = "4px";
    btn.style.background = "#065fd4";
    btn.style.color = "#ffffff";
    btn.style.border = "none";
    btn.style.fontSize = "12px";
    btn.style.verticalAlign = "middle";

    btn.addEventListener("click", onButtonClick);

    // 삽입 위치 결정.
    // 링크를 감싸는 .value div 는 overflow:hidden 이라 그 안에 넣으면 잘려서 안 보임.
    // 따라서 .value 바깥(부모인 .left, overflow:visible)의 .value 바로 뒤에 넣는다.
    const valueDiv = link.closest(".value");
    const fadeable = link.closest(".video-url-fadeable");
    const anchorEl = valueDiv || fadeable || link;
    if (anchorEl.parentNode) {
      anchorEl.parentNode.insertBefore(btn, anchorEl.nextSibling);
    } else {
      link.parentNode.insertBefore(btn, link.nextSibling);
    }
  }

  /**
   * 기존(오래된) 버튼을 제거합니다. (영상 간 이동 시 호출)
   */
  function removeButton() {
    deepQueryAll("#" + BTN_ID).forEach((el) => el.remove());
  }

  /**
   * 현재 상태를 확인하여 필요하면 버튼을 주입합니다.
   */
  function maybeInject() {
    if (isEditPage()) {
      injectButton();
    } else {
      // 편집 페이지가 아니면 버튼 제거
      removeButton();
    }
  }

  // --- 디바운스 유틸 ---
  let debounceTimer = null;
  function debouncedMaybeInject() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(maybeInject, 300);
  }

  // --- DOM 변경 감지 (SPA 콘텐츠 비동기 로딩 대응) ---
  const observer = new MutationObserver(() => {
    debouncedMaybeInject();
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- URL 변경 감지 (Studio SPA 라우팅 대응) ---
  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // 영상이 바뀌었으므로 오래된 버튼 제거 후 재주입 시도
      removeButton();
      debouncedMaybeInject();
    }
  }
  // history API 패치 (pushState/replaceState 후에도 감지)
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function () {
      const ret = orig.apply(this, arguments);
      checkUrlChange();
      return ret;
    };
  });
  window.addEventListener("popstate", checkUrlChange);
  // 폴백: 주기적으로 URL 변경 확인 + 버튼 주입 재시도
  // (Shadow DOM 내부 변경은 MutationObserver 가 감지하지 못하므로 폴링으로 보완)
  setInterval(() => {
    checkUrlChange();
    // 편집 페이지인데 버튼이 아직 없으면 계속 주입 시도
    if (isEditPage() && !findExistingButton()) {
      injectButton();
    }
  }, 1500);

  // 최초 실행
  maybeInject();
})();
