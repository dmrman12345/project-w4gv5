const API = "https://api.github.com/repos/dmrman12345/project-w4gv5";

const CACHE_NAME = "slope-plus-files-v1";
const TINY_CACHE_NAME = "tiny-fishing-files-v5";

const TINY_BASE = "random/TinyFishing/";
const TINY_RAW_BASE = "https://raw.githubusercontent.com/dmrman12345/project-w4gv5/main/random/TinyFishing/";

const FILES = {
  loader: "random/SlopePlus/Build/UnityLoader.js",
  config: "random/SlopePlus/Build/SlopePlusWeb.json",
  data: "random/SlopePlus/Build/SlopePlusWeb.data.unityweb",
  code: "random/SlopePlus/Build/SlopePlusWeb.wasm.code.unityweb",
  framework: "random/SlopePlus/Build/SlopePlusWeb.wasm.framework.unityweb"
};

const menu = document.getElementById("menu");
const gameView = document.getElementById("gameView");
const gameContainer = document.getElementById("gameContainer");
const statusBox = document.getElementById("status");

const playSlopeButton = document.getElementById("playSlope");
const playTinyFishingButton = document.getElementById("playTinyFishing");

const backButton = document.getElementById("backButton");

const clearSlopeDataButton = document.getElementById("clearSlopeData");
const deleteSlopeFilesButton = document.getElementById("deleteSlopeFiles");
const clearTinyDataButton = document.getElementById("clearTinyData");
const deleteTinyFilesButton = document.getElementById("deleteTinyFiles");

let slopeRedirects = {};
let xhrRedirects = {};
let tinyBlobUrls = new Set();
let tinyMemoryCache = new Map();
let tinyAssetObjectURLs = new Map();
let tinyLoadedSupportScripts = new Set();
let tinyNoopScriptURL = null;
let tinyTranslationCSV = null;
let tinyOriginalFileReader = null;

let xhrPatched = false;
let audioWorkletPatched = false;

let slopeLoading = false;
let tinyLoading = false;

let activeGame = null;
let loaderScript = null;


function status(message) {
  statusBox.textContent = message;
}


// ------------------------------------------------------------
// MENU NAVIGATION
// ------------------------------------------------------------

playSlopeButton.addEventListener("click", async () => {
  if (slopeLoading) return;

  activeGame = "slope";
  slopeLoading = true;

  playSlopeButton.disabled = true;

  menu.classList.add("hidden");
  gameView.classList.remove("hidden");

  statusBox.style.display = "block";
  gameContainer.innerHTML = "";

  await startSlope();

  slopeLoading = false;
  playSlopeButton.disabled = false;
});


if (playTinyFishingButton) {
  playTinyFishingButton.addEventListener("click", async () => {
    if (tinyLoading) return;

    activeGame = "tiny";
    tinyLoading = true;

    playTinyFishingButton.disabled = true;

    menu.classList.add("hidden");
    gameView.classList.remove("hidden");

    statusBox.style.display = "block";
    gameContainer.innerHTML = "";

    await startTinyFishing();

    tinyLoading = false;
    playTinyFishingButton.disabled = false;
  });
}


backButton.addEventListener("click", () => {
  if (activeGame === "tiny") {
    location.reload();
    return;
  }

  gameContainer.innerHTML = "";

  if (loaderScript) {
    loaderScript.remove();
    loaderScript = null;
  }

  gameView.classList.add("hidden");
  menu.classList.remove("hidden");

  statusBox.style.display = "block";
  status("Select a game to play.");

  activeGame = null;
  slopeLoading = false;
});


// ------------------------------------------------------------
// CACHE SYSTEM
// ------------------------------------------------------------

async function cachedFetch(url, options = {}, cacheName = CACHE_NAME) {
  if (cacheName === TINY_CACHE_NAME && tinyMemoryCache.has(url)) {
    console.log("[GAME CACHE] Using in-memory Tiny Fishing file:", url);
    const blob = tinyMemoryCache.get(url);
    return new Response(blob.slice(0, blob.size));
  }

  let cache = null;

  if ("caches" in window) {
    try {
      cache = await caches.open(cacheName);

      const saved = await cache.match(url);

      if (saved) {
        console.log("[GAME CACHE] Using saved file:", url);
        return saved;
      }
    } catch (error) {
      console.warn("[GAME CACHE] Cache unavailable:", error);
    }
  }

  console.log("[GAME CACHE] Downloading:", url);

  const response = await fetch(url, {
    ...options,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(
      "Download failed: " + response.status + " (" + url + ")"
    );
  }

  if (cache) {
    try {
      await cache.put(url, response.clone());
      console.log("[GAME CACHE] Saved:", url);
    } catch (error) {
      console.warn("[GAME CACHE] Could not save:", error);
    }
  }

  return response;
}


// ------------------------------------------------------------
// GITHUB API
// ------------------------------------------------------------

async function getTree() {
  const response = await fetch(
    API + "/git/trees/main?recursive=1",
    { cache: "no-store" }
  );

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      "GitHub tree request failed (" +
      response.status +
      "): " +
      details
    );
  }

  const tree = await response.json();

  if (!tree.tree || tree.truncated) {
    throw new Error("GitHub returned an incomplete file tree.");
  }

  return tree;
}


async function getRawFile(path, cacheName = CACHE_NAME) {
  const response = await cachedFetch(
    API + "/contents/" + path + "?ref=main",
    {
      headers: {
        Accept: "application/vnd.github.raw+json"
      }
    },
    cacheName
  );

  return await response.text();
}


// ------------------------------------------------------------
// URL REDIRECT SYSTEM
// ------------------------------------------------------------

function findRedirect(url) {
  if (typeof url !== "string") return null;

  const keys = Object.keys(xhrRedirects)
    .sort((a, b) => b.length - a.length);

  for (const key of keys) {
    if (url.includes(key)) {
      return xhrRedirects[key];
    }
  }

  return null;
}


// ------------------------------------------------------------
// INTERCEPT GAME REQUESTS
// ------------------------------------------------------------

function patchXHR(redirects) {
  Object.assign(xhrRedirects, redirects);

  if (xhrPatched) return;

  xhrPatched = true;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    if (typeof url === "string") {
      const redirect = findRedirect(url);

      if (redirect) {
        url = redirect;
      }
    }

    this._gameApiRequest =
      typeof url === "string" &&
      (url.includes("api.github.com") || tinyBlobUrls.has(url));

    this._gameUrl = url;

    this._gameCacheName =
      tinyBlobUrls.has(url)
        ? TINY_CACHE_NAME
        : CACHE_NAME;

    return originalOpen.call(this, method, url, ...args);
  };


  XMLHttpRequest.prototype.send = function(...args) {
    if (!this._gameApiRequest) {
      return originalSend.apply(this, args);
    }

    const xhr = this;
    const url = xhr._gameUrl;
    const cacheName = xhr._gameCacheName;

    let readyState = 1;
    let responseData = null;
    let responseHeaders = "";
    let responseStatus = 0;
    let responseStatusText = "";

    const responseType = xhr.responseType;

    Object.defineProperties(xhr, {
      readyState: {
        configurable: true,
        get: () => readyState
      },

      status: {
        configurable: true,
        get: () => responseStatus
      },

      statusText: {
        configurable: true,
        get: () => responseStatusText
      },

      response: {
        configurable: true,
        get: () => responseData
      },

      responseText: {
        configurable: true,
        get: () => {
          if (responseData === null) return "";

          if (typeof responseData === "string") {
            return responseData;
          }

          return "";
        }
      }
    });

    xhr.getAllResponseHeaders = function() {
      return responseHeaders;
    };

    xhr.getResponseHeader = function(name) {
      const escapedName = name.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      const match = responseHeaders.match(
        new RegExp("^" + escapedName + ": (.*)$", "im")
      );

      return match ? match[1] : null;
    };


    function fireEvent(name) {
      xhr.dispatchEvent(new Event(name));
    }


    async function download() {
      try {
        const response = await cachedFetch(
          url,
          {
            headers: {
              Accept: "application/vnd.github.raw+json"
            }
          },
          cacheName
        );

        responseStatus = response.status;
        responseStatusText = response.statusText;

        responseHeaders = "";

        response.headers.forEach((value, name) => {
          responseHeaders += name + ": " + value + "\r\n";
        });

        readyState = 2;
        fireEvent("readystatechange");

        const buffer = await response.arrayBuffer();
        const text = new TextDecoder().decode(buffer);

        if (responseType === "arraybuffer") {
          responseData = buffer;
        } else if (responseType === "blob") {
          responseData = new Blob([buffer]);
        } else if (responseType === "json") {
          responseData = JSON.parse(text);
        } else {
          responseData = text;
        }

        readyState = 3;
        fireEvent("readystatechange");

        readyState = 4;
        fireEvent("readystatechange");

        fireEvent("load");
        fireEvent("loadend");

      } catch (error) {
        console.error("[GAME XHR ERROR]", error);

        readyState = 4;
        responseStatus = 0;

        fireEvent("readystatechange");
        fireEvent("error");
        fireEvent("loadend");
      }
    }

    fireEvent("loadstart");
    download();
  };
}


// ------------------------------------------------------------
// TINY FISHING AUDIO WORKLET
// ------------------------------------------------------------

function patchAudioWorklet() {
  if (audioWorkletPatched) return;

  if (!window.AudioWorklet) {
    console.warn("[TINY FISHING] AudioWorklet is unavailable.");
    return;
  }

  const prototype = AudioWorklet.prototype;

  if (!prototype || !prototype.addModule) return;

  const originalAddModule = prototype.addModule;

  prototype.addModule = function(moduleURL, options) {
    const redirect = findRedirect(String(moduleURL));

    if (!redirect) {
      return originalAddModule.call(this, moduleURL, options);
    }

    return cachedFetch(
      redirect,
      {
        headers: {
          Accept: "application/vnd.github.raw+json"
        }
      },
      TINY_CACHE_NAME
    )
      .then(response => response.text())
      .then(code => {
        const blob = new Blob(
          [code],
          { type: "text/javascript" }
        );

        const blobURL = URL.createObjectURL(blob);

        return originalAddModule.call(
          this,
          blobURL,
          options
        ).finally(() => {
          URL.revokeObjectURL(blobURL);
        });
      });
  };

  audioWorkletPatched = true;
}


// ------------------------------------------------------------
// PER-GAME DATA AND FILE CONTROLS
// ------------------------------------------------------------

// Tiny Fishing's save key is defined in its cookie manager script.
// Slope Plus uses the Unity WebGL PlayerPrefs key derived from its build config.
const TINY_SAVE_KEY = "TinyFishingCoolmathSave";
const SLOPE_SAVE_KEY = "unity.playerprefs.Slope Plus.Slope Plus";

function getGameCachePrefixes(game) {
  return game === "tiny" ? ["tiny-fishing-files-"] : ["slope-plus-files-"];
}


async function deleteGameFiles(game) {
  const button = game === "tiny" ? deleteTinyFilesButton : deleteSlopeFilesButton;
  if (!button || button.disabled) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Deleting...";

  try {
    if (!("caches" in window)) {
      throw new Error("This browser preview does not support Cache Storage.");
    }

    const prefixes = getGameCachePrefixes(game);
    const names = await caches.keys();

    const matching = names.filter(name =>
      prefixes.some(prefix => name === prefix || name.startsWith(prefix))
    );

    let deleted = 0;

    for (const name of matching) {
      if (await caches.delete(name)) deleted++;
    }

    if (game === "tiny") {
      tinyMemoryCache.clear();

      for (const objectURL of tinyAssetObjectURLs.values()) {
        URL.revokeObjectURL(objectURL);
      }

      tinyAssetObjectURLs.clear();

      if (tinyNoopScriptURL) {
        URL.revokeObjectURL(tinyNoopScriptURL);
        tinyNoopScriptURL = null;
      }

      tinyBlobUrls.clear();
      tinyLoadedSupportScripts.clear();
      window.tinyFishingFileMap = null;
      xhrRedirects = {};

    } else {
      slopeRedirects = {};
    }

    alert(
      (game === "tiny" ? "Tiny Fishing" : "Slope Plus") +
      " game files deleted. " +
      deleted +
      " cached file group(s) removed. The game will download fresh copies next time."
    );

  } catch (error) {
    console.error("[DELETE GAME FILES]", error);
    alert("Could not delete game files: " + error.message);

  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}


function clearGameData(game) {
  const button = game === "tiny" ? clearTinyDataButton : clearSlopeDataButton;
  if (!button || button.disabled) return;

  const gameName = game === "tiny" ? "Tiny Fishing" : "Slope Plus";
  const saveKey = game === "tiny" ? TINY_SAVE_KEY : SLOPE_SAVE_KEY;

  if (!confirm(
    "Clear " + gameName +
    " progress? This resets saved progress and cannot be undone."
  )) return;

  try {
    const hadSave = localStorage.getItem(saveKey) !== null;

    localStorage.removeItem(saveKey);

    if (game === "tiny") {
      alert(
        hadSave
          ? "Tiny Fishing save data cleared. Reloading the game hub..."
          : "No Tiny Fishing save data was found. Reloading the game hub..."
      );

    } else {
      alert(
        hadSave
          ? "Slope Plus PlayerPrefs data cleared. Reloading the game hub..."
          : "No Slope Plus PlayerPrefs save key was found. Other Unity save storage, if used by this build, has not been touched. Reloading the game hub..."
      );
    }

    window.location.reload();

  } catch (error) {
    console.error("[CLEAR GAME DATA]", error);
    alert("Could not clear " + gameName + " data: " + error.message);
  }
}


const deleteWarning = document.getElementById("deleteWarning");
const deleteWarningTitle = document.getElementById("deleteWarningTitle");
const deleteWarningGame = document.getElementById("deleteWarningGame");
const cancelDeleteButton = document.getElementById("cancelDeleteFiles");
const confirmDeleteButton = document.getElementById("confirmDeleteFiles");

let pendingDeleteGame = null;

function openDeleteWarning(game) {
  pendingDeleteGame = game;
  const gameName = game === "tiny" ? "Tiny Fishing" : "Slope Plus";

  deleteWarningTitle.textContent = "Delete Game Files?";
  deleteWarningGame.textContent =
    "Are you sure you want to delete " + gameName + "'s downloaded files?";

  deleteWarning.classList.remove("hidden");
  cancelDeleteButton.focus();
}

function closeDeleteWarning() {
  deleteWarning.classList.add("hidden");
  pendingDeleteGame = null;
}

clearSlopeDataButton.addEventListener("click", () => clearGameData("slope"));
deleteSlopeFilesButton.addEventListener("click", () => openDeleteWarning("slope"));
clearTinyDataButton.addEventListener("click", () => clearGameData("tiny"));
deleteTinyFilesButton.addEventListener("click", () => openDeleteWarning("tiny"));

cancelDeleteButton.addEventListener("click", closeDeleteWarning);

confirmDeleteButton.addEventListener("click", async () => {
  const game = pendingDeleteGame;
  if (!game) return;

  closeDeleteWarning();
  await deleteGameFiles(game);
});

deleteWarning.addEventListener("click", event => {
  if (event.target === deleteWarning) closeDeleteWarning();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !deleteWarning.classList.contains("hidden")) {
    closeDeleteWarning();
  }
});


// ------------------------------------------------------------
// START SLOPE PLUS
// ------------------------------------------------------------

async function startSlope() {
  try {
    status("Connecting to GitHub...");

    const tree = await getTree();

    const fileMap = new Map(
      tree.tree.map(file => [file.path, file])
    );

    const entries = {};

    for (const [key, path] of Object.entries(FILES)) {
      const file = fileMap.get(path);

      if (!file) {
        throw new Error("Missing GitHub file: " + path);
      }

      entries[key] = file;
    }

    const redirects = {};

    for (const key of ["data", "code", "framework"]) {
      const filename = FILES[key].split("/").pop();

      redirects[filename] =
        API + "/git/blobs/" + entries[key].sha;
    }

    slopeRedirects = redirects;
    patchXHR(redirects);

    status("Loading Unity loader...");

    const loaderText = await getRawFile(FILES.loader);

    if (loaderScript) {
      loaderScript.remove();
    }

    loaderScript = document.createElement("script");
    loaderScript.textContent = loaderText;

    document.head.appendChild(loaderScript);

    if (typeof UnityLoader === "undefined") {
      throw new Error("UnityLoader did not initialize.");
    }

    status("Starting Slope Plus...");

    const configURL =
      API + "/contents/" + FILES.config + "?ref=main";

    UnityLoader.instantiate(
      "gameContainer",
      configURL,
      {
        onProgress: function(instance, progress) {
          status(
            "Loading Slope Plus: " +
            Math.round(progress * 100) +
            "%"
          );

          if (progress >= 1) {
            statusBox.style.display = "none";
          }
        }
      }
    );

  } catch (error) {
    console.error("[SLOPE ERROR]", error);
    status("ERROR: " + error.message);
  }
}


// ------------------------------------------------------------
// TINY FISHING RESOURCE BASE + SUPPORT SCRIPTS
// ------------------------------------------------------------

function setTinyFishingBase() {
  let base = document.querySelector("base[data-tiny-fishing]");

  if (!base) {
    base = document.createElement("base");
    base.dataset.tinyFishing = "true";
    document.head.insertBefore(base, document.head.firstChild);
  }

  base.href = TINY_RAW_BASE;
}


function tinyRelativePathFromURL(value) {
  if (typeof value !== "string" || !value) return null;

  let candidate = value;

  try {
    const parsed = new URL(value, TINY_RAW_BASE);
    const marker = "/random/TinyFishing/";
    const markerIndex = parsed.pathname.indexOf(marker);

    if (markerIndex !== -1) {
      candidate = parsed.pathname.slice(markerIndex + marker.length);

    } else if (parsed.origin === new URL(TINY_RAW_BASE).origin) {
      candidate = parsed.pathname.replace(/^\/+/, "");

      if (candidate.startsWith("main/random/TinyFishing/")) {
        candidate = candidate.slice("main/random/TinyFishing/".length);
      }

    } else {
      return null;
    }

  } catch (error) {
    candidate = value.split("?")[0].split("#")[0];
  }

  candidate = candidate.replace(/^\/+/, "");

  // GameMaker can request the localization CSV without its directory.
  if (candidate === "trads.csv") {
    candidate = "html5game/trads.csv";
  }

  if (candidate.startsWith(TINY_BASE)) {
    candidate = candidate.slice(TINY_BASE.length);
  }

  return candidate || null;
}


function getTinyObjectURL(relativePath) {
  const normalized = tinyRelativePathFromURL(relativePath);
  if (!normalized) return null;

  if (tinyAssetObjectURLs.has(normalized)) {
    return tinyAssetObjectURLs.get(normalized);
  }

  const fullPath = TINY_BASE + normalized;
  const file = window.tinyFishingFileMap && window.tinyFishingFileMap.get(fullPath);

  if (!file) return null;

  const blobURL = API + "/git/blobs/" + file.sha;
  const blob = tinyMemoryCache.get(blobURL);

  if (!blob) return null;

  const objectURL = URL.createObjectURL(blob);
  tinyAssetObjectURLs.set(normalized, objectURL);

  return objectURL;
}


function getTinyBlob(relativePath) {
  const normalized = tinyRelativePathFromURL(relativePath);
  if (!normalized) return null;

  const fullPath = TINY_BASE + normalized;
  const file = window.tinyFishingFileMap && window.tinyFishingFileMap.get(fullPath);

  if (!file) return null;

  return tinyMemoryCache.get(API + "/git/blobs/" + file.sha) || null;
}


function patchTinyImageLoading() {
  if (window.__tinyImageLoadingPatched) return;

  window.__tinyImageLoadingPatched = true;

  const imageSrc = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    "src"
  );

  if (imageSrc && imageSrc.get && imageSrc.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: imageSrc.enumerable,
      get: imageSrc.get,
      set(value) {
        const localURL = getTinyObjectURL(String(value));
        imageSrc.set.call(this, localURL || value);
      }
    });
  }

  const originalSetAttribute = Element.prototype.setAttribute;

  Element.prototype.setAttribute = function(name, value) {
    if (typeof name === "string" && name.toLowerCase() === "src") {
      if (this instanceof HTMLScriptElement) {
        const relativePath = tinyRelativePathFromURL(String(value));

        if (relativePath && tinyLoadedSupportScripts.has(relativePath)) {
          if (!tinyNoopScriptURL) {
            tinyNoopScriptURL = URL.createObjectURL(
              new Blob(
                ["/* Tiny Fishing extension already loaded from cache. */"],
                { type: "text/javascript" }
              )
            );
          }

          console.log(
            "[TINY FISHING] GameMaker extension request satisfied from cache:",
            relativePath
          );

          return originalSetAttribute.call(
            this,
            name,
            tinyNoopScriptURL
          );
        }
      }

      if (this instanceof HTMLImageElement) {
        const localURL = getTinyObjectURL(String(value));

        return originalSetAttribute.call(
          this,
          name,
          localURL || value
        );
      }
    }

    return originalSetAttribute.call(this, name, value);
  };

  const originalFetch = window.fetch.bind(window);

  window.fetch = function(input, options) {
    const requestURL =
      typeof input === "string" ? input :
      input && typeof input.url === "string" ? input.url : "";

    const blob = getTinyBlob(requestURL);

    if (blob) {
      return Promise.resolve(
        new Response(blob.slice(0, blob.size), {
          status: 200,
          headers: {
            "Content-Type": blob.type || "application/octet-stream"
          }
        })
      );
    }

    const localURL = getTinyObjectURL(requestURL);

    return originalFetch(localURL || input, options);
  };

  console.log(
    "[TINY FISHING] Image, fetch, and asset requests now use cached files."
  );
}


async function getTinyFileText(relativePath) {
  const fullPath = TINY_BASE + relativePath;
  const file = window.tinyFishingFileMap && window.tinyFishingFileMap.get(fullPath);

  if (!file) {
    throw new Error(
      "Tiny Fishing file was not found in the GitHub tree: " + relativePath
    );
  }

  const blobURL = API + "/git/blobs/" + file.sha;
  let blob = tinyMemoryCache.get(blobURL);

  if (!blob) {
    const response = await cachedFetch(
      blobURL,
      { headers: { Accept: "application/vnd.github.raw+json" } },
      TINY_CACHE_NAME
    );

    blob = await response.blob();
    tinyMemoryCache.set(blobURL, blob);
  }

  return await blob.text();
}


function registerTinyScriptReference(relativePath) {
  const filename = relativePath.split("/").pop();
  const objectURL = getTinyObjectURL(relativePath);

  if (!objectURL) {
    throw new Error(
      "Cached Tiny Fishing script URL is missing: " + relativePath
    );
  }

  const existing = document.getElementById(filename);

  if (existing) existing.remove();

  const reference = document.createElement("script");

  reference.type = "text/plain";
  reference.src = TINY_RAW_BASE + relativePath;
  reference.id = "tinyFishingReference_" + filename;
  reference.dataset.tinyFishingReference = relativePath;
  reference.dataset.originalFilename = filename;
  reference.dataset.cachedObjectURL = objectURL;

  document.head.appendChild(reference);
}


async function loadTinySupportScript(relativePath) {
  let code = await getTinyFileText(relativePath);

  if (!code || !code.trim()) {
    throw new Error(
      "GitHub returned an empty Tiny Fishing script: " + relativePath
    );
  }

  if (relativePath === "html5game/tph_SDKManager.js") {
    const firstClassStart = code.indexOf("class Sdkmanager");
    const secondClassStart = code.indexOf(
      "class Sdkmanager",
      firstClassStart + 1
    );

    const wrapperStart = code.lastIndexOf("// wrapper");

    if (
      firstClassStart !== -1 &&
      secondClassStart > firstClassStart &&
      wrapperStart > secondClassStart
    ) {
      code = code.slice(secondClassStart);

      code += `

 // Expose the SDK symbols for GameMaker's extension callbacks.
window.Sdkmanager = Sdkmanager;
window.js_sdkm_init = js_sdkm_init;
window.js_sdkm_call_function = js_sdkm_call_function;
window.js_sdkm_show_ad = js_sdkm_show_ad;
`;
    } else {
      throw new Error(
        "Could not safely prepare the Tiny Fishing SDK manager."
      );
    }

    if (
      !/class\s+Sdkmanager/.test(code) ||
      !/function\s+js_sdkm_init\s*\(/.test(code)
    ) {
      throw new Error(
        "Tiny Fishing SDK manager is missing its class or initialization function."
      );
    }
  }

  await injectTinyScript(code, relativePath);

  tinyLoadedSupportScripts.add(relativePath);

  console.log("[TINY FISHING] Loaded support script:", relativePath);
}


// ------------------------------------------------------------
// CREATE TINY FISHING DOM
// ------------------------------------------------------------

function createTinyFishingDOM() {
  const root = document.createElement("div");

  root.id = "tinyFishingRoot";

  root.style.cssText = `
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: black;
  `;

  const gameDiv = document.createElement("div");

  gameDiv.id = "gm4html5_div_id";
  gameDiv.className = "gm4html5_div_class";

  gameDiv.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  `;

  const canvas = document.createElement("canvas");

  canvas.id = "canvas";
  canvas.width = 0;
  canvas.height = 0;

  canvas.style.cssText = `
    display: block;
    max-width: 100%;
    max-height: 100%;
    touch-action: none;
  `;

  installTinyMouseCompatibility(canvas);

  gameDiv.appendChild(canvas);
  root.appendChild(gameDiv);

  const loadingImageIds = [
    "img_bgLoading",
    "img_pcLogoLoading",
    "img_loadingbar",
    "img_loadingbaroverlay"
  ];

  for (const id of loadingImageIds) {
    const image = document.createElement("img");

    image.id = id;
    image.alt = "";

    image.style.cssText =
      "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";

    root.appendChild(image);
  }

  gameContainer.appendChild(root);

  const style = document.createElement("style");

  style.id = "tinyFishingStyle";

  style.textContent = `
    #tinyFishingRoot canvas {
      width: auto !important;
      height: auto !important;
      max-width: 100% !important;
      max-height: 100% !important;
    }
  `;

  document.head.appendChild(style);
}


function installTinyMouseCompatibility(canvas) {
  if (!canvas || canvas.dataset.tinyMouseBridge === "true") return;

  canvas.dataset.tinyMouseBridge = "true";

  let activeMousePointer = null;

  function dispatchMouseEvent(pointerEvent, mouseEventName, buttons) {
    const mouseEvent = new MouseEvent(mouseEventName, {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: mouseEventName === "mousedown" ? 1 : 0,
      screenX: pointerEvent.screenX,
      screenY: pointerEvent.screenY,
      clientX: pointerEvent.clientX,
      clientY: pointerEvent.clientY,
      ctrlKey: pointerEvent.ctrlKey,
      shiftKey: pointerEvent.shiftKey,
      altKey: pointerEvent.altKey,
      metaKey: pointerEvent.metaKey,
      button: pointerEvent.button,
      buttons: buttons === undefined ? pointerEvent.buttons : buttons
    });

    Object.defineProperty(mouseEvent, "__tinyFishingSynthetic", {
      value: true
    });

    canvas.dispatchEvent(mouseEvent);
  }

  canvas.addEventListener("pointerdown", event => {
    if (event.pointerType !== "mouse" || !event.isPrimary) return;

    activeMousePointer = event.pointerId;

    dispatchMouseEvent(event, "mousedown", event.buttons || 1);
  }, true);

  canvas.addEventListener("pointermove", event => {
    if (event.pointerType !== "mouse") return;

    if (
      activeMousePointer !== null &&
      event.pointerId !== activeMousePointer
    ) {
      return;
    }

    dispatchMouseEvent(event, "mousemove", event.buttons);
  }, true);

  canvas.addEventListener("pointerup", event => {
    if (event.pointerType !== "mouse") return;

    if (
      activeMousePointer !== null &&
      event.pointerId !== activeMousePointer
    ) {
      return;
    }

    dispatchMouseEvent(event, "mouseup", 0);
    activeMousePointer = null;
  }, true);

  canvas.addEventListener("pointercancel", event => {
    if (event.pointerType !== "mouse") return;

    if (
      activeMousePointer !== null &&
      event.pointerId !== activeMousePointer
    ) {
      return;
    }

    dispatchMouseEvent(event, "mouseup", 0);
    activeMousePointer = null;
  }, true);

  console.log(
    "[TINY FISHING] Pointer-to-mouse compatibility bridge installed."
  );
}


// ------------------------------------------------------------
// INJECT TINY FISHING SCRIPTS
// ------------------------------------------------------------

function injectTinyScript(code, name) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");

    const blob = new Blob(
      [code],
      { type: "text/javascript" }
    );

    const blobURL = URL.createObjectURL(blob);

    script.type = "text/javascript";
    script.async = false;

    script.dataset.tinyFishing = name;
    script.dataset.originalFilename = name.split("/").pop();
    script.dataset.originalSrc = TINY_RAW_BASE + name;

    if (name.endsWith(".js")) {
      script.id = name.split("/").pop();
    } else {
      script.id = "tinyFishing_" + name;
    }

    script.onload = () => {
      console.log("[TINY FISHING] Script executed:", name);
      resolve(script);
    };

    script.onerror = () => {
      URL.revokeObjectURL(blobURL);

      reject(
        new Error("Tiny Fishing script failed to load: " + name)
      );
    };

    script.src = blobURL;

    document.head.appendChild(script);
  });
}


async function preloadTinyFiles(tinyFiles) {
  if (!("caches" in window)) {
    throw new Error(
      "This preview does not support persistent Cache Storage."
    );
  }

  const cache = await caches.open(TINY_CACHE_NAME);

  const queue = tinyFiles.map(file => ({
    file,
    url: API + "/git/blobs/" + file.sha
  }));

  let nextIndex = 0;
  let completed = 0;
  let restored = 0;

  const workerCount = Math.min(4, queue.length);

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= queue.length) return;

      const item = queue[index];

      let savedResponse = await cache.match(item.url);

      if (savedResponse) {
        restored++;

        console.log(
          "[TINY FISHING CACHE] Restored:",
          item.file.path
        );

      } else {
        console.log(
          "[TINY FISHING CACHE] Downloading:",
          item.file.path
        );

        const response = await fetch(item.url, {
          cache: "no-store",
          headers: {
            Accept: "application/vnd.github.raw+json"
          }
        });

        if (!response.ok) {
          throw new Error(
            "Could not download " +
            item.file.path +
            ": HTTP " +
            response.status
          );
        }

        await cache.put(item.url, response.clone());

        savedResponse = await cache.match(item.url);

        if (!savedResponse) {
          throw new Error(
            "File downloaded but was not saved to persistent cache: " +
            item.file.path
          );
        }
      }

      const blob = await savedResponse.blob();

      tinyMemoryCache.set(item.url, blob);

      completed++;

      status(
        "Caching Tiny Fishing files: " +
        completed +
        "/" +
        queue.length
      );

      console.log(
        "[TINY FISHING CACHE] Verified:",
        item.file.path,
        "(" + completed + "/" + queue.length + ")"
      );
    }
  }

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => worker()
    )
  );

  const missingFiles = [];

  for (const item of queue) {
    if (!(await cache.match(item.url))) {
      missingFiles.push(item.file.path);
    }
  }

  if (completed !== tinyFiles.length || missingFiles.length) {
    throw new Error(
      "Tiny Fishing cache is incomplete: " +
      completed +
      "/" +
      tinyFiles.length +
      " files verified. Missing: " +
      missingFiles.join(", ")
    );
  }

  const manifest = {
    version: 1,
    files: tinyFiles.map(file => ({
      path: file.path,
      sha: file.sha
    }))
  };

  await cache.put(
    TINY_RAW_BASE + "__tiny_fishing_cache_manifest__.json",
    new Response(
      JSON.stringify(manifest),
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    )
  );

  console.log(
    "[TINY FISHING CACHE] All " +
    completed +
    " files are saved and verified (" +
    restored +
    " restored from cache, " +
    (completed - restored) +
    " newly downloaded)."
  );
}


// ------------------------------------------------------------
// START TINY FISHING
// ------------------------------------------------------------

async function startTinyFishing() {
  try {
    setTinyFishingBase();
    createTinyFishingDOM();

    status("Connecting to GitHub...");

    const tree = await getTree();

    const tinyFiles = tree.tree.filter(file =>
      file.type === "blob" &&
      file.path.startsWith(TINY_BASE)
    );

    const fileMap = new Map(
      tinyFiles.map(file => [file.path, file])
    );

    window.tinyFishingFileMap = fileMap;

    const requiredFiles = [
      TINY_BASE + "TinyFishing.js",
      TINY_BASE + "jquery.min.js",
      TINY_BASE + "html5game/trads.csv",
      TINY_BASE + "html5game/sound/worklets/audio-worklet.js"
    ];

    for (const path of requiredFiles) {
      if (!fileMap.has(path)) {
        throw new Error("Missing Tiny Fishing file: " + path);
      }
    }

    if (tinyFiles.length !== 57) {
      console.warn(
        "[TINY FISHING] Expected 57 files; GitHub currently returned " +
        tinyFiles.length +
        "."
      );
    }

    const redirects = {};

    for (const file of tinyFiles) {
      const relativePath = file.path.slice(TINY_BASE.length);
      const blobURL = API + "/git/blobs/" + file.sha;

      redirects[relativePath] = blobURL;

      // Fallback: GameMaker may request the translation file
      // using only "trads.csv" instead of "html5game/trads.csv".
      if (relativePath === "html5game/trads.csv") {
        redirects["trads.csv"] = blobURL;
      }

      tinyBlobUrls.add(blobURL);
    }

    patchXHR(redirects);
    patchAudioWorklet();

    status("Downloading Tiny Fishing files...");

    await preloadTinyFiles(tinyFiles);

    // Load the localization CSV before GameMaker initializes.
    tinyTranslationCSV = await getTinyFileText("html5game/trads.csv");

    status("Preparing Tiny Fishing...");

    patchTinyImageLoading();

    for (const file of tinyFiles) {
      const relativePath = file.path.slice(TINY_BASE.length);

      getTinyObjectURL(relativePath);
    }

    const jqueryCode = await getTinyFileText("jquery.min.js");
    const gameCode = await getTinyFileText("TinyFishing.js");

    await injectTinyScript(jqueryCode, "jquery");

    const supportScriptOrder = [
      "html5game/tph_SDKManager.js",
      "html5game/uph_djl.js",
      "html5game/vph_HTML5Func.js",
      "html5game/wph_API_Fullscreen.js",
      "html5game/xph_external.js",
      "html5game/yph_djs.js",
      "html5game/zph_cookieManager.js",
      "html5game/aqh_GameAnalytics.js",
      "html5game/bqh_GameAnalyticsExt.js",
      "html5game/eqh_gamesnacks.js"
    ];

    for (const relativePath of supportScriptOrder) {
      const fullPath = TINY_BASE + relativePath;

      if (!fileMap.has(fullPath)) {
        throw new Error(
          "Missing Tiny Fishing support script: " + relativePath
        );
      }

      await loadTinySupportScript(relativePath);
    }

    await injectTinyScript(gameCode, "engine");

    // GameMaker reads included text files through its internal synchronous reader.
    // Serve the already-downloaded CSV directly instead of relying on a browser request.
    if (typeof window._xl === "function" && typeof tinyTranslationCSV === "string") {
      tinyOriginalFileReader = window._xl;

      window._xl = function(filename, localOnly) {
        const normalized = String(filename || "")
          .replace(/\\/g, "/")
          .split("/")
          .pop()
          .toLowerCase();

        if (normalized === "trads.csv") {
          return tinyTranslationCSV;
        }

        return tinyOriginalFileReader.apply(this, arguments);
      };

      console.log("[TINY FISHING] Registered trads.csv with GameMaker's file reader.");
    } else {
      throw new Error("Could not register trads.csv with GameMaker's file reader.");
    }

    if (typeof window.GameMaker_Init !== "function") {
      throw new Error("GameMaker_Init was not found.");
    }

    status("Starting Tiny Fishing...");

    window.GameMaker_Init();

    statusBox.style.display = "none";

    console.log("[TINY FISHING] Started successfully.");

  } catch (error) {
    console.error("[TINY FISHING ERROR]", error);

    status("ERROR: " + error.message);
  }
}
