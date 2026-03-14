// ==UserScript==
// @name         DragonRealms MCP Bridge
// @author       ChatGPT
// @namespace    https://example.local/
// @version      0.2.1
// @description  Pulls commands from local MCP bridge and posts game output back with selector capture mode.
// @match        https://*.play.net/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(() => {
  const BRIDGE_URL = "http://127.0.0.1:3989";
  const TOKEN = "";
  const COMMAND_POLL_MS = 1000;
  const OUTPUT_POLL_MS = 1200;
  const PROFILE_STORAGE_KEY = "dr.mcp.selectorProfile.v1";
  const INPUT_CAPTURE_HOTKEY = "Alt+Shift+I";
  const OUTPUT_CAPTURE_HOTKEY = "Alt+Shift+O";

  const DEFAULT_PROFILE = {
    inputSelector: "input[type='text'], textarea",
    outputSelectors: ["#output", ".game-output", ".output"]
  };

  function loadProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
      if (!raw) {
        return DEFAULT_PROFILE;
      }

      const parsed = JSON.parse(raw);
      const inputSelector = typeof parsed?.inputSelector === "string" ? parsed.inputSelector : DEFAULT_PROFILE.inputSelector;
      const outputSelectors = Array.isArray(parsed?.outputSelectors)
        ? parsed.outputSelectors.filter((value) => typeof value === "string" && value.trim().length > 0)
        : DEFAULT_PROFILE.outputSelectors;

      return {
        inputSelector,
        outputSelectors: outputSelectors.length > 0 ? outputSelectors : DEFAULT_PROFILE.outputSelectors
      };
    } catch (_error) {
      return DEFAULT_PROFILE;
    }
  }

  function saveProfile(profile) {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  }

  let selectorProfile = loadProfile();

  function briefFlash(message) {
    const banner = document.createElement("div");
    banner.textContent = message;
    banner.style.position = "fixed";
    banner.style.top = "12px";
    banner.style.right = "12px";
    banner.style.zIndex = "2147483647";
    banner.style.padding = "8px 10px";
    banner.style.background = "#111827";
    banner.style.border = "1px solid #3b82f6";
    banner.style.color = "#e5e7eb";
    banner.style.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    banner.style.borderRadius = "8px";
    document.body.appendChild(banner);

    setTimeout(() => {
      banner.remove();
    }, 2400);
  }

  function cssPathFromElement(element) {
    if (!element || element.nodeType !== 1) {
      return "";
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === 1 && parts.length < 5) {
      let selector = current.nodeName.toLowerCase();

      if (current.id) {
        selector += `#${CSS.escape(current.id)}`;
        parts.unshift(selector);
        break;
      }

      if (current.classList.length > 0) {
        const classes = Array.from(current.classList)
          .slice(0, 2)
          .map((name) => `.${CSS.escape(name)}`)
          .join("");
        selector += classes;
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((sibling) => sibling.nodeName === current.nodeName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }

      parts.unshift(selector);
      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function captureSelector(kind) {
    briefFlash(`Capture mode: click ${kind === "input" ? "the command input" : "the output panel"}`);

    function onClick(event) {
      event.preventDefault();
      event.stopPropagation();

      const element = event.target;
      const selector = cssPathFromElement(element);
      if (!selector) {
        briefFlash("Unable to capture selector from clicked element.");
        teardown();
        return;
      }

      if (kind === "input") {
        selectorProfile = {
          ...selectorProfile,
          inputSelector: selector
        };
        saveProfile(selectorProfile);
        briefFlash(`Saved input selector: ${selector}`);
      } else {
        const mergedOutputSelectors = [selector, ...selectorProfile.outputSelectors.filter((value) => value !== selector)].slice(0, 5);
        selectorProfile = {
          ...selectorProfile,
          outputSelectors: mergedOutputSelectors
        };
        saveProfile(selectorProfile);
        briefFlash(`Saved output selector: ${selector}`);
      }

      teardown();
    }

    function teardown() {
      document.removeEventListener("click", onClick, true);
    }

    document.addEventListener("click", onClick, true);
  }

  document.addEventListener("keydown", (event) => {
    if (!event.altKey || !event.shiftKey) {
      return;
    }

    if (event.code === "KeyI") {
      event.preventDefault();
      captureSelector("input");
      return;
    }

    if (event.code === "KeyO") {
      event.preventDefault();
      captureSelector("output");
    }
  });

  briefFlash(`Bridge ready. Capture hotkeys: ${INPUT_CAPTURE_HOTKEY}, ${OUTPUT_CAPTURE_HOTKEY}`);

  function bridgeHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (TOKEN) {
      headers["x-dr-token"] = TOKEN;
    }
    return headers;
  }

  let lastNetworkError = "";

  function reportNetworkError(message) {
    if (lastNetworkError === message) {
      return;
    }
    lastNetworkError = message;
    briefFlash(`Bridge error: ${message}`);
    console.error("[DR-MCP-Bridge]", message);
  }

  function clearNetworkError() {
    lastNetworkError = "";
  }

  function requestBridge(method, url, body) {
    const headers = bridgeHeaders();

    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url,
          headers,
          data: body ? JSON.stringify(body) : undefined,
          onload: (response) => {
            resolve({
              ok: response.status >= 200 && response.status < 300,
              status: response.status,
              text: response.responseText ?? ""
            });
          },
          onerror: () => {
            reject(new Error("Request failed (network/CORS/security policy)."));
          }
        });
      });
    }

    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      text: await response.text()
    }));
  }

  function findInputElement() {
    const captured = document.querySelector(selectorProfile.inputSelector);
    if (captured instanceof HTMLInputElement || captured instanceof HTMLTextAreaElement) {
      return captured;
    }

    return document.querySelector(DEFAULT_PROFILE.inputSelector);
  }

  function readVisibleGameText() {
    const selectors = [...selectorProfile.outputSelectors, ...DEFAULT_PROFILE.outputSelectors];
    const uniqueSelectors = Array.from(new Set(selectors));
    const candidates = uniqueSelectors.map((selector) => document.querySelector(selector)).concat(document.body);

    for (const node of candidates) {
      if (node && node.textContent && node.textContent.trim().length > 0) {
        return node.textContent.trim();
      }
    }

    return "";
  }

  function triggerCommandSubmit(input) {
    const keyboardOptions = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };

    input.dispatchEvent(new KeyboardEvent("keydown", keyboardOptions));
    input.dispatchEvent(new KeyboardEvent("keypress", keyboardOptions));
    input.dispatchEvent(new KeyboardEvent("keyup", keyboardOptions));

    if (input.form) {
      input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      if (typeof input.form.requestSubmit === "function") {
        input.form.requestSubmit();
      }
    }

    const nearbyButton = input.closest("form")?.querySelector("button[type='submit'], input[type='submit'], button")
      || document.querySelector("button[type='submit'], .send, .send-button, .cmd-send");

    if (nearbyButton instanceof HTMLElement) {
      nearbyButton.click();
    }
  }

  async function pollCommands() {
    try {
      const response = await requestBridge("GET", `${BRIDGE_URL}/io/commands?limit=10`);

      if (!response.ok) {
        reportNetworkError(`command poll returned ${response.status}`);
        return;
      }
      clearNetworkError();

      const payload = response.text ? JSON.parse(response.text) : {};
      const commands = payload?.commands ?? [];
      if (!Array.isArray(commands) || commands.length === 0) {
        return;
      }

      const input = findInputElement();
      if (!input) {
        return;
      }

      for (const item of commands) {
        const command = String(item.command ?? "").trim();
        if (!command) {
          continue;
        }

        input.focus();
        input.value = command;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        triggerCommandSubmit(input);
      }
    } catch (error) {
      reportNetworkError(error instanceof Error ? error.message : "Unknown poll error.");
    }
  }

  let lastOutputHash = "";

  async function pushOutput() {
    try {
      const text = readVisibleGameText();
      if (!text) {
        return;
      }

      const hash = text.slice(-5000);
      if (hash === lastOutputHash) {
        return;
      }
      lastOutputHash = hash;

      const response = await requestBridge("POST", `${BRIDGE_URL}/io/output`, {
        text: hash,
        source: "userscript"
      });

      if (!response.ok) {
        reportNetworkError(`output push returned ${response.status}`);
        return;
      }

      clearNetworkError();
    } catch (error) {
      reportNetworkError(error instanceof Error ? error.message : "Unknown output push error.");
    }
  }

  setInterval(pollCommands, COMMAND_POLL_MS);
  setInterval(pushOutput, OUTPUT_POLL_MS);
})();
