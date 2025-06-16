// Import is not yet allowed in firefox, so for now I put tint_image in manifest.json
import { tint_image } from "./tint_image.js"; // Assumes tint_image.js is also updated to message offscreen.js

// Cams_Ashes Forked Changes: START
// Original:
// let browser = chrome;
let browser = globalThis.browser || globalThis.chrome; // Use browser polyfill or fallback to chrome
// Cams_Ashes Forked Changes: END

let BROWSERACTION_ICON = "/Images/Icon_Windowed_Mono@1x.png";

// Cams_Ashes Forked Changes: START
// Summary of changes:
// - is_firefox: Renamed to is_firefox_promise for clarity as it holds a Promise.
// Original:
// let browser_info_promise = browser.runtime.getBrowserInfo
//   ? browser.runtime.getBrowserInfo()
//   : Promise.resolve({ name: "Chrome" });
// let is_firefox = browser_info_promise.then(
//   (browser_info) => browser_info.name === "Firefox",
// );
let browser_info_promise = browser.runtime.getBrowserInfo
  ? browser.runtime.getBrowserInfo()
  : Promise.resolve({ name: "Chrome" }); // Default to Chrome if API not present
let is_firefox_promise = browser_info_promise.then( // Renamed from is_firefox
  (browser_info) => browser_info.name === "Firefox",
);
// Cams_Ashes Forked Changes: END

// Cams_Ashes Forked Changes: START
// Summary of changes:
// - Function: Renamed from `is_valid_window` to `is_valid_window_for_context`.
// - Parameter: Added `isSourceIncognito` to check window validity against a specific context.
// - Logic: `window.incognito` check now compares against `isSourceIncognito`.
// - Robustness: Added a check for `!window` at the beginning.
/**
 * @param {import("webextension-polyfill-ts").Windows.Window} window The candidate window
 * @param {boolean} isSourceIncognito Whether the tab being moved is from an incognito context
 */
let is_valid_window_for_context = (window, isSourceIncognito) => {
  if (!window) return false; // Guard against undefined window object
  return (
    window.incognito === isSourceIncognito && // Window MUST match source tab's incognito status
    window.type === "normal" &&
    window.state !== "minimized"
  );
};
// Cams_Ashes Forked Changes: END

/**
 * Firefox can't take the `focused` property to browser.windows.create/update
 * So I just take it out when using firefox 🤷‍♀️
 * @param {import("webextension-polyfill-ts").Windows.CreateCreateDataType} window_properties
 * @returns {Promise<import("webextension-polyfill-ts").Windows.CreateCreateDataType>}
 */
let firefix_window = async (window_properties) => {
  // Cams_Ashes Forked Changes: START
  // Original:
  // let is_it_firefox = await is_firefox;
  let is_it_firefox = await is_firefox_promise; // Uses the renamed promise
  // Cams_Ashes Forked Changes: END
  if (is_it_firefox) {
    let { focused, ...good_properties } = window_properties;
    return good_properties;
  } else {
    return window_properties;
  }
};

// Cams_Ashes Forked Changes: START
// Summary of changes:
// - Function: Renamed from `get_fallback_window` to retain the name while changing its signature and logic for context.
// - Parameters: Accepts `currentWindowId` and `isSourceIncognito`.
// - Logic: Uses `is_valid_window_for_context` to filter windows based on the source tab's incognito status.
// - Fallback: More robustly tries to find a suitable window, prioritizing last focused if it matches context.
/**
 * @param {number} currentWindowId The ID of the window the tab is currently in (the popup)
 * @param {boolean} isSourceIncognito Whether the tab being moved is from an incognito context
 * @returns {Promise<import("webextension-polyfill-ts").Windows.Window | null>}
 */
const get_fallback_window = async (currentWindowId, isSourceIncognito) => {
  try {
    const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
    
    const suitableWindows = windows.filter(win => 
        is_valid_window_for_context(win, isSourceIncognito) && 
        win.id !== currentWindowId
    );

    if (suitableWindows.length > 0) {
      const lastFocusedOverall = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
      if (lastFocusedOverall && lastFocusedOverall.id !== currentWindowId && is_valid_window_for_context(lastFocusedOverall, isSourceIncognito)) {
          return lastFocusedOverall;
      }
      return suitableWindows.sort((a,b) => (a.tabs?.length || 0) - (b.tabs?.length || 0))[0] || null; 
    }
    return null;
  } catch (error) {
    console.warn("[WINDOWED Background] Error in get_fallback_window (context-aware):", error);
    return null;
  }
};
// Cams_Ashes Forked Changes: END

// TODO Instead of using this static height, I can maybe "ping" the page I'm popup-izing
// after it is done becoming a popup: then it can figure out it's position itself
// (and check the size of it's current header itself)
const Chrome_Popup_Menubar_Height = 22; // Do `window.outerHeight - window.innerHeight` in a popup tab

// Cams_Ashes Forked Changes: START
// Original:
// /**
//  * @typedef WindowedMode
//  * @type {"fullscreen" | "windowed" | "in-window" | "fullscreen" | "ask"}
//  */
/**
 * @typedef WindowedMode 
 * @type {"fullscreen" | "windowed" | "in-window" | "ask"} // Corrected duplicate "fullscreen"
 */
// Cams_Ashes Forked Changes: END

/**
 * @param {string} mode
 * @param {boolean} disabled
 * @returns {WindowedMode}
 */
let clean_mode = (mode, disabled) => {
  if (mode == "fullscreen" || mode == "windowed" || mode == "in-window") {
    return mode;
  }
  return disabled === true ? "fullscreen" : "ask";
};

let ALL_MODE = "mode(*)";
let ALL_PIP = "pip(*)";

// Cams_Ashes Forked Changes: START
// Summary of changes to get_host_config:
// - Robustness: Added checks for invalid `tab`, `tab.url`, or unsupported protocols (e.g., `chrome://`).
// - URL Parsing: Wrapped `new URL(tab.url)` in a try-catch block.
// - Key Naming: Used more descriptive variables for storage keys (e.g., `host_mode_key`).
// - Disabled Logic: Clarified logic for `disabled_val` using `hasOwnProperty` on the host key.
// - Storage Access: Wrapped `browser.storage.sync.get` in try-catch for robustness.
// - Return Value: Added `host` to the returned object.
/** @param {import("webextension-polyfill-ts").Tabs.Tab} tab */
let get_host_config = async (tab) => {
  if (!tab || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("about:") || tab.url.startsWith("edge://")) {
    return { mode: "ask", pip: false, all_mode: "ask", all_pip: false, host: null };
  }

  let host;
  try {
    host = new URL(tab.url).host;
  } catch (e) {
    return { mode: "ask", pip: false, all_mode: "ask", all_pip: false, host: null };
  }
  
  let host_mode_key = `mode(${host})`;
  let host_disabled_key = host; 
  let host_pip_key = `pip(${host})`;

  let storedData = {};
  try {
    storedData = (await browser.storage.sync.get([
        host_mode_key,
        host_disabled_key,
        host_pip_key,
        ALL_MODE,
        ALL_PIP,
    ])) ?? {};
  } catch (error) {
    console.warn("[WINDOWED Background] Error accessing storage.sync:", error);
  }
  
  let mode_val = storedData[host_mode_key] ?? storedData[ALL_MODE];
  let disabled_val = storedData.hasOwnProperty(host_disabled_key); 
  let pip_val = storedData[host_pip_key] ?? storedData[ALL_PIP];

  return {
    mode: clean_mode(mode_val, disabled_val),
    pip: pip_val === true,
    all_mode: clean_mode(storedData[ALL_MODE], false), 
    all_pip: storedData[ALL_PIP] === true,
    host: host 
  };
};
// Cams_Ashes Forked Changes: END

// Cams_Ashes Forked Changes: START - Replaced onMessage wrapper with a direct listener and added setupOffscreenDocumentIfNeeded.
// Original onMessage wrapper:
// /**
//  * Wrapper to do some basic routing on extension messaging
//  * @param {string} type
//  * @param {(message: any, sender: import("webextension-polyfill-ts").Runtime.MessageSender) => Promise<any>} fn
//  * @return {void}
//  */
// let onMessage = (type, fn) => { // ... (original wrapper logic) ... };

// --- Offscreen Document Setup (New Function) ---
let offscreenDocumentSetupPromise = null;
async function setupOffscreenDocument(path) { 
    if (!browser.offscreen) { 
        console.warn("[WINDOWED Background] browser.offscreen API not available.");
        return Promise.reject("Offscreen API not available");
    }
    if (!offscreenDocumentSetupPromise) {
        offscreenDocumentSetupPromise = (async () => {
            const offscreenUrl = browser.runtime.getURL(path);
            try {
                const existingContexts = await browser.runtime.getContexts({
                    contextTypes: ["OFFSCREEN_DOCUMENT"],
                    documentUrls: [offscreenUrl],
                });
                if (existingContexts.length > 0) {
                    // console.log("[WINDOWED Background] Offscreen document already exists.");
                    return;
                }
                // console.log("[WINDOWED Background] Creating offscreen document...");
                await browser.offscreen.createDocument({
                    url: path, 
                    reasons: [ // Use official enum values
                        browser.offscreen.Reason.DOM_PARSER, 
                        browser.offscreen.Reason.CANVAS,    
                        browser.offscreen.Reason.MATCH_MEDIA_SYNC 
                    ],
                    justification: "Image tinting using OffscreenCanvas and theme detection via matchMedia.",
                });
                // console.log("[WINDOWED Background] Offscreen document created successfully.");
            } catch (err) {
                console.error("[WINDOWED Background] Error setting up offscreen document:", err.message);
                offscreenDocumentSetupPromise = null; 
                throw err; // Propagate for retry or logging
            }
        })();
    }
    return offscreenDocumentSetupPromise;
}
// Attempt to set it up early.
setupOffscreenDocument("Background/offscreen.html").catch(e => console.warn("Initial offscreen setup failed, will retry on demand."));


// --- New Centralized Message Handling ---
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
        // console.warn("[WINDOWED Background] Received invalid message:", message);
        return false; // Signal synchronous handling, no response sent
    }

    // console.log("[WINDOWED Background] Received message:", message.type, "from sender:", sender.tab ? `tab ${sender.tab.id}` : "extension context");

    if (message.type === "get_windowed_config") {
        if (sender.tab) {
            get_host_config(sender.tab)
                .then(config => sendResponse({ type: "resolve", value: config }))
                .catch(err => sendResponse({ type: "reject", value: { message: err.message, stack: err.stack } }));
        } else { 
            console.warn("[WINDOWED Background] get_windowed_config received without sender.tab");
            sendResponse({ type: "reject", value: { message: "Missing sender.tab for get_windowed_config." } }); 
        }
        return true; // Indicates asynchronous response
    }
    
    else if (message.type === "please_make_me_a_popup") {
        // This handler incorporates changes for incognito robustness
        if (!sender.tab || !message.position) {
             sendResponse({ type: "reject", value: { message: "Missing sender.tab or position for please_make_me_a_popup." }});
             return true; 
        }
        (async () => { 
            try {
                const originatingTab = sender.tab;
                let currentWindowDetails = await browser.windows.get(originatingTab.windowId);
                const { left: screenLeft = 0, top: screenTop = 0, type: windowType } = currentWindowDetails;
                const frame = message.position;

                let creationOptions = {
                    type: "popup", focused: true,
                    left: Math.round(screenLeft + frame.left),
                    top: Math.round(screenTop + frame.top - Chrome_Popup_Menubar_Height),
                    width: Math.round(frame.width),
                    height: Math.round(frame.height + Chrome_Popup_Menubar_Height),
                };

                if (originatingTab.incognito) {
                    creationOptions.incognito = true; // Explicitly set incognito for the new window
                } else {
                    creationOptions.incognito = false;
                }
                
                let final_options_for_window = await firefix_window(creationOptions);

                if (windowType === "popup" && currentWindowDetails.id === originatingTab.windowId ) {
                    let updateOptions = { ...final_options_for_window }; 
                    delete updateOptions.incognito; // Cannot update incognito status
                    delete updateOptions.type;     // Cannot update type
                    delete updateOptions.tabId;    // Not used for update
                    await browser.windows.update(originatingTab.windowId, updateOptions);
                    sendResponse({ type: "resolve", value: "Popup updated" });
                } else {
                    let new_creation_options = {...final_options_for_window};
                    delete new_creation_options.tabId; // Create empty window first
                    
                    const created_window = await browser.windows.create(new_creation_options);
                    if (created_window && created_window.id) {
                        // Move tab after window creation
                        await browser.tabs.move(originatingTab.id, { windowId: created_window.id, index: 0 });
                        await browser.tabs.update(originatingTab.id, { active: true });
                        if (await is_firefox_promise) { 
                            await browser.windows.update(created_window.id, { titlePreface: "Windowed: " });
                        }
                        sendResponse({ type: "resolve", value: "Popup created and tab moved" });
                    } else {
                        throw new Error("Window creation did not return a valid window object.");
                    }
                }
            } catch (err) { 
                console.error("[WINDOWED Background] Error in please_make_me_a_popup:", err);
                let errorMessage = err.message;
                if (err.message && err.message.toLowerCase().includes("incognito")) { // Add hint for user
                    errorMessage = "Could not create/update window. Ensure 'Allow in Incognito' is enabled for the extension. " + err.message;
                }
                sendResponse({ type: "reject", value: { message: errorMessage, stack: err.stack } }); 
            }
        })();
        return true; 
    }
    
    else if (message.type === "please_make_me_a_tab_again") {
        // This handler incorporates changes for incognito context when re-tabbing
        if (!sender.tab) {
             sendResponse({ type: "reject", value: { message: "Missing sender.tab for please_make_me_a_tab_again." } });
             return true;
        }
        (async () => {
            try {
                const tabToMove = sender.tab;
                let currentPopupWindowDetails = await browser.windows.get(tabToMove.windowId);

                if (currentPopupWindowDetails.type === "normal") {
                    sendResponse({ type: "resolve", value: "Tab already in a normal window." });
                    return;
                }
                const isSourceIncognito = tabToMove.incognito; // Get incognito status from tab being moved
                let fallback_window = await get_fallback_window(tabToMove.windowId, isSourceIncognito); 

                if (fallback_window) {
                    await browser.tabs.move(tabToMove.id, { windowId: fallback_window.id, index: -1 });
                    await browser.tabs.update(tabToMove.id, { active: true });
                    await browser.windows.update(fallback_window.id, { focused: true });
                } else {
                    await browser.windows.create({
                        tabId: tabToMove.id, type: "normal",
                        incognito: isSourceIncognito, // Create new window in correct context
                        focused: true
                    });
                }
                sendResponse({ type: "resolve", value: "Tab re-integrated" });
            } catch (err) { 
                console.error("[WINDOWED Background] Error in please_make_me_a_tab_again:", err);
                sendResponse({ type: "reject", value: { message: err.message, stack: err.stack } }); 
            }
        })();
        return true; 
    }
    
    else if (message.type === "update_windowed_button") {
        (async () => {
            try {
                let tabsToUpdate = message.id
                    ? [(await browser.tabs.get(message.id))] // Wrap in array, await
                    : await browser.tabs.query(message.query || {}); // Default query if undefined
                for (let tab of tabsToUpdate) {
                    if (tab && tab.id) await update_button_on_tab(tab); // Check tab validity
                }
                sendResponse({ type: "resolve", value: "Button update initiated."});
            } catch (err) { sendResponse({ type: "reject", value: { message: err.message, stack: err.stack } }); }
        })();
        return true; 
    }
    
    else if (message.type === "offscreen_matchMedia_request" && message.query) {
        // This message type is intended for offscreen.js
        // Background script SENDS this, does not typically LISTEN for it, unless offscreen calls back here.
        // If offscreen uses sendResponse, this block isn't needed. If it used sendMessage to BG, it would be.
        console.warn("[WINDOWED Background] Received 'offscreen_matchMedia_request'. This should normally be sent to offscreen.js.");
        sendResponse({type: "reject", value: {message: "Background should not receive 'offscreen_matchMedia_request' directly."}});
        return false;
    }

    return false; // Default for unhandled message types
});

// --- New onConnect listener for handshake with Content.js ---
browser.runtime.onConnect.addListener((port) => {
    if (port.name === "content-script-init") {
        port.onMessage.addListener((msg) => {
            if (msg.type === "content_script_ping") {
                try { port.postMessage({ type: "background_ready" }); } 
                catch (e) { /* Port might disconnect if content script refreshed */ }
            }
        });
    }
});
// Cams_Ashes Forked Changes: END
// Following code block: current_port_promises, ping_content_script

// Cams_Ashes Forked Changes: START - Modified ping_content_script (details from prior change included)
/** @type {{ [tabid: number]: Promise<boolean> }} */
let current_port_promises = {};
/**
 * Check if we can connect with the Windowed content script in a tab
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
let ping_content_script = async (tabId) => {
  if (!tabId) return Promise.resolve(false);
  if (current_port_promises[tabId] != null) {
    return await current_port_promises[tabId];
  }
  
  current_port_promises[tabId] = new Promise((resolve) => {
    let port;
    try {
      port = browser.tabs.connect(tabId, { name: "background_ping_to_content" });
      let responded = false;
      port.onMessage.addListener((message) => {
        if (message.type === "content_script_pong") { // Content script needs to implement this pong
            if (!responded) { responded = true; resolve(true); try{port.disconnect();}catch(e){} }
        }
      });
      port.onDisconnect.addListener(() => {
        if (!responded) { responded = true; resolve(false); }
        delete current_port_promises[tabId];
      });
      try { // Additional try-catch for postMessage in case port invalid immediately
        port.postMessage({type: "background_ping"});
      } catch (e) {
        if(!responded) { responded = true; resolve(false); }
        delete current_port_promises[tabId];
        return; // Exit if postMessage fails
      }
      setTimeout(() => {
        if (!responded) { 
            responded = true; resolve(false); 
            try {port.disconnect();} catch(e){} 
            delete current_port_promises[tabId];
        }
      }, 300); 
    } catch (err) { 
      resolve(false); 
      delete current_port_promises[tabId]; 
    }
  });
  return await current_port_promises[tabId];
};
// Cams_Ashes Forked Changes: END
// Following code block: setupOffscreenDocument (already presented as new block), matchMedia


// Cams_Ashes Forked Changes: START - Modified matchMedia to use offscreen_matchMedia_request
// Original matchMedia and setupOffscreenDocument are effectively replaced by setupOffscreenDocumentIfNeeded
// and the new matchMedia that messages offscreen.js.
/**
 * @param {string} query
 * @returns {Promise<{matches: boolean, media: string}>} 
 */
let matchMedia = async (query) => {
  await setupOffscreenDocument("Background/offscreen.html"); 
  try {
    // Send message to offscreen.js (which handles window.matchMedia)
    const response = await browser.runtime.sendMessage({
      type: "offscreen_matchMedia_request", // New distinct type
      query: query,
      // target: "offscreen", // Target might not be needed if message types are unique
    });
    // Handle response from offscreen.js (which should be {type:"resolve", value:{matches,media}})
    if (response && response.type === "resolve" && response.value) {
        return response.value; 
    }
    let errorMsg = (response?.value?.message) || "Invalid or no response from offscreen document for matchMedia";
    throw new Error(errorMsg);
  } catch (e) {
    console.warn(`[WINDOWED Background] matchMedia request to offscreen failed: ${e.message}. Falling back.`);
    return { matches: false, media: query }; // Fallback response
  }
};
// Cams_Ashes Forked Changes: END
// Following code block: icon_theme_color

// Cams_Ashes Forked Changes: START - Modified icon_theme_color for robustness & using updated matchMedia
/**
 * Tries to figure out the default icon color
 * @param {import("webextension-polyfill-ts").Tabs.Tab} tab
 * @returns {Promise<string>}
 */
let icon_theme_color = async (tab) => {
  if (!tab || !tab.windowId) return "#5f6368"; // Guard for robustness
  
  if (await is_firefox_promise) { // Uses renamed promise
    try {
        let theme = await browser.theme.getCurrent(tab.windowId);
        if (theme?.colors?.icons != null) return theme.colors.icons;
        if (theme?.colors?.popup_text != null) return theme.colors.popup_text;
    } catch(e) {
        // console.warn("[WINDOWED Background] Could not get theme for Firefox tab.", e);
        // Fall through
    }
  }
  try {
    const mqResult = await matchMedia("(prefers-color-scheme: dark)"); // Calls new matchMedia
    return mqResult.matches ? "rgba(255,255,255,0.8)" : "#5f6368";
  } catch (e) {
    // console.warn("[WINDOWED Background] prefers-color-scheme matchMedia failed in icon_theme_color:", e);
    return "#5f6368"; // Default
  }
};
// Cams_Ashes Forked Changes: END
// Following code block: notify_tab_state

// Cams_Ashes Forked Changes: START - Modified notify_tab_state to use tabs.sendMessage
/**
 * @param {number} tabId
 * @param {any} properties
 */
let notify_tab_state = async (tabId, properties) => {
  try {
    // Content.js would need a listener for 'WINDOWED-background-notify-state'
    await browser.tabs.sendMessage(tabId, { type: 'WINDOWED-background-notify-state', data: properties });
  } catch (e) {
    // This often fails harmlessly if the content script isn't injected/listening on a specific page
    // console.warn(`[WINDOWED Background] Could not send notify_tab_state to tab ${tabId}: ${e.message}`);
  }
};
// Cams_Ashes Forked Changes: END
// Following code block: apply_browser_action

// Cams_Ashes Forked Changes: START - Modified update_button_on_tab for robustness, offscreen calls, and correct URLs
/**
 * @param {import("webextension-polyfill-ts").Tabs.Tab} tab
 */
let update_button_on_tab = async (tab) => {
  if (!tab || !tab.id || !tab.url || tab.url.startsWith("chrome-extension://")) { // More robust guard
      return; 
  }
  let has_contentscript_active = false;
  if (tab.status === "complete" && !(tab.url.startsWith("about:") || tab.url.startsWith("chrome:") || tab.url.startsWith("edge:"))) {
    has_contentscript_active = await ping_content_script(tab.id); // Use modified ping
  }
  
  const absoluteIconPath = browser.runtime.getURL(BROWSERACTION_ICON); // Crucial for fetch in offscreen
  let title = "";
  let iconColor = null; 

  // ... (Original logic determining title and iconColor) ...
  if (has_contentscript_active === false && tab.url === "about:blank") {
    iconColor = await icon_theme_color(tab); title = `Windowed`;
  } else if (!has_contentscript_active && (tab.url.match(/^about:/) || tab.url.match(/^chrome:\/\//) || tab.url.match(/^edge:\/\//) || tab.url.match(/^https?:\/\/chrome\.google\.com/) || tab.url.match(/^https?:\/\/support\.mozilla\.org/) || tab.url === "")) {
    iconColor = "rgba(208, 2, 27, .22)"; title = `For security reasons, windowed is not supported on this domain.`;
  } else if (tab.status === "complete" && !has_contentscript_active) {
    iconColor = "#D0021B"; title = "This page needs to be reloaded for Windowed to activate. Click here to reload.";
  } else {
    let config = await get_host_config(tab); // config includes host
    let currentHost = config.host || "this domain"; 
    if (config.mode === "fullscreen" && config.pip === false) {
        iconColor = "rgba(133, 133, 133, 0.5)"; title = `Windowed is disabled on ${currentHost}, click to re-activate`;
        await notify_tab_state(tab.id, { disabled: true });
    } else if (config.mode === config.all_mode && config.pip === config.all_pip) {
        iconColor = await icon_theme_color(tab); title = `Windowed is enabled on ${currentHost}`;
        await notify_tab_state(tab.id, { disabled: false });
    } else {
        iconColor = "#16a8a8"; title = `Windowed is enabled on ${currentHost} (specific config)`;
        await notify_tab_state(tab.id, { disabled: false });
    }
  }
  // End of original logic for title/iconColor
  
  if (iconColor) {
    try {
      await setupOffscreenDocument("Background/offscreen.html"); // Ensure offscreen doc is ready
      const tintedIconData = await tint_image(absoluteIconPath, iconColor); // `tint_image` now messages offscreen
      await apply_browser_action(tab.id, { icon: tintedIconData, title: title });
    } catch (e) {
        console.warn(`[WINDOWED Background] Failed to tint/set icon for tab ${tab.id} (${tab.url}): ${e.message}`);
        await browser.action.setTitle({ tabId: tab.id, title: title }); // Fallback: set title only
    }
  } else if (title) { // If no color change but title needs update
    await browser.action.setTitle({ tabId: tab.id, title: title });
  }
};
// Cams_Ashes Forked Changes: END
// Following code block: browser.runtime.onInstalled.addListener

// Cams_Ashes Forked Changes: START - Tab event listeners made more robust
// Original:
// browser.runtime.onInstalled.addListener(async () => {
//   let all_tabs = await browser.tabs.query({});
//   for (let tab of all_tabs) {
//     await update_button_on_tab(tab);
//   }
// });
browser.runtime.onInstalled.addListener(async (details) => { // Added details parameter
  console.log("[WINDOWED Background] Extension event:", details.reason); // Log reason
  try {
    let all_tabs = await browser.tabs.query({});
    for (let tab of all_tabs) { 
      if (tab && tab.id) await update_button_on_tab(tab); // Check tab & tab.id
    }
  } catch(e) { console.warn("[WINDOWED Background] Error updating buttons onInstalled:", e); }
});
// Original:
// browser.tabs.onUpdated.addListener(async (tabId, changed, tab) => {
//   if (changed.url != null || changed.status != null) {
//     await update_button_on_tab(tab);
//   }
// });
browser.tabs.onUpdated.addListener(async (tabId, changed, tab) => {
  // Check specific conditions and fetch full tab info if 'tab' param is incomplete
  if (tab && tab.id && (changed.url || changed.status === "complete")) {
    await update_button_on_tab(await browser.tabs.get(tabId)); // Get full, fresh tab object
  }
});
// Original:
// browser.tabs.onActivated.addListener(async ({ tabId }) => {
//   let tab = await browser.tabs.get(tabId);
//   await update_button_on_tab(tab);
// });
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    let tab = await browser.tabs.get(tabId);
    if(tab && tab.id) await update_button_on_tab(tab); // Check tab & tab.id
  } catch(e) { /* Tab might no longer exist if quickly closed/navigated */ }
});
// Cams_Ashes Forked Changes: END
// Following code block: Startup IIAFE

// Cams_Ashes Forked Changes: START - Modified Startup IIAFE
// Original:
// (async () => {
//   let all_tabs = await browser.tabs.query({});
//   for (let tab of all_tabs) {
//     await update_button_on_tab(tab);
//   }
// })();
(async () => {
  console.log("[WINDOWED Background] Service worker starting initial tab updates.");
  try {
    await setupOffscreenDocument("Background/offscreen.html"); // Ensure offscreen document exists early
    let all_tabs = await browser.tabs.query({});
    for (let tab of all_tabs) { 
      if (tab && tab.id) await update_button_on_tab(tab); // Check tab and tab.id
    }
  } catch (error) { 
    console.warn("[WINDOWED Background] Error during initial startup tasks:", error); 
  }
  console.log("[WINDOWED Background] Service worker initial tasks complete. Waiting for connections/messages."); // Added confirmation log
})();
// Cams_Ashes Forked Changes: END
