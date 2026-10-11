/**
 * Jarvis Browser Bridge — content script
 *
 * Runs in the page. Two jobs:
 *   1. OBSERVE: build a compact DOM/AX snapshot (title, URL, interactive
 *      elements with labels) for the agent to plan with.
 *   2. ACT: perform click / type / scroll as trusted events.
 *
 * ---------------------------------------------------------------------------
 * PAGE CONTENT IS DATA, NEVER INSTRUCTIONS.
 * ---------------------------------------------------------------------------
 * Everything read from the page (text, labels, attributes, hidden nodes) is
 * treated as untrusted data for observation only. Nothing on the page can
 * invoke extension capabilities, grant permissions, or influence the consent
 * flow — actions execute ONLY when the background service worker, after its
 * own local permission check, sends an explicit act command. A malicious page
 * cannot click itself, cannot approve itself, and cannot talk to the relay.
 */
(function () {
  "use strict";

  // Guard against double-injection (background re-injects before each action).
  if (window.__jbb_injected) return;
  window.__jbb_injected = true;

  var REF_ATTR = "data-jbb-ref";
  var MAX_ELEMENTS = 120;

  var INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='textbox']",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function labelFor(el) {
    // SECURITY (enemy audit 2026-10-11): never include the value of a password
    // field. Autofilled/typed passwords would otherwise ship in plaintext
    // inside observe snapshots to the relay and driver.
    var tag = el.tagName.toLowerCase();
    var isPassword = tag === "input" && (el.type || "text").toLowerCase() === "password";
    return (
      el.getAttribute("aria-label") ||
      el.innerText ||
      (!isPassword && el.value) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.getAttribute("title") ||
      tag
    ).trim().replace(/\s+/g, " ").slice(0, 80);
  }

  function typeFor(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") return "input:" + (el.type || "text");
    if (tag === "button" || el.getAttribute("role") === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    return tag;
  }

  /** Build the observation snapshot sent to the agent. */
  function buildSnapshot() {
    var els = document.querySelectorAll(INTERACTIVE_SELECTOR);
    var interactives = [];
    var n = 0;
    for (var i = 0; i < els.length && n < MAX_ELEMENTS; i++) {
      var el = els[i];
      if (!isVisible(el)) continue;
      var ref = "e" + n;
      el.setAttribute(REF_ATTR, ref);
      interactives.push({
        ref: ref,
        label: labelFor(el),
        type: typeFor(el),
        name: el.getAttribute("name") || null
      });
      n++;
    }
    return {
      title: document.title,
      url: location.href,
      interactives: interactives,
      truncated: els.length > MAX_ELEMENTS
    };
  }

  function findByRef(ref) {
    return document.querySelector("[" + REF_ATTR + "='" + ref + "']");
  }

  // SECURITY (enemy audit round 2): the page owns its DOM and can move
  // data-jbb-ref attributes between observe and act, rebinding an approved
  // ref to a different element. Verify the element still matches what the
  // user approved; fail closed on mismatch (the driver re-observes).
  function verifyTarget(el, ref, expectedLabel) {
    if (!el) throw new Error("no element for ref " + ref);
    if (expectedLabel && labelFor(el) !== expectedLabel) {
      throw new Error("element changed since observation (expected '" +
        expectedLabel + "')");
    }
    return el;
  }

  function doClick(ref, expectedLabel) {
    var el = verifyTarget(findByRef(ref), ref, expectedLabel);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.click(); // trusted event, same as a user click
    return "clicked '" + labelFor(el) + "'";
  }

  function doType(ref, value, expectedLabel) {
    var el = verifyTarget(findByRef(ref), ref, expectedLabel);
    if (!("value" in el) && el.tagName.toLowerCase() !== "textarea") {
      throw new Error("element is not typable: " + labelFor(el));
    }
    el.focus();
    // Use the native value setter so framework listeners fire correctly,
    // then dispatch the events a real keystroke would produce.
    var setter = Object.getOwnPropertyDescriptor(
      el.tagName.toLowerCase() === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "typed into '" + labelFor(el) + "'";
  }

  function doScroll(direction, amount) {
    var px = amount || 600;
    if (direction === "up") window.scrollBy({ top: -px, behavior: "smooth" });
    else if (direction === "down") window.scrollBy({ top: px, behavior: "smooth" });
    else if (direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
    else if (direction === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    return "scrolled " + direction;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.kind !== "string" || msg.kind.indexOf("jbb.content.") !== 0) {
      return false;
    }
    try {
      if (msg.kind === "jbb.content.observe") {
        sendResponse({ ok: true, snapshot: buildSnapshot() });
      } else if (msg.kind === "jbb.content.act") {
        var a = msg.action || {};
        var t = a.target || {};
        var detail;
        if (a.type === "click") detail = doClick(t.ref, t.label);
        else if (a.type === "type") detail = doType(t.ref, a.value, t.label);
        else if (a.type === "scroll") detail = doScroll(a.direction, a.amount);
        else throw new Error("unknown action type: " + a.type);
        sendResponse({ ok: true, detail: detail });
      } else {
        sendResponse({ ok: false, error: "unknown content message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
    return false; // synchronous response
  });
})();
