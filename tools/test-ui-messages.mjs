import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function createFakeDocument() {
  const nodes = new Map();
  return {
    body: {
      append(node) {
        nodes.set(`#${node.id}`, node);
      }
    },
    createElement(tagName) {
      return {
        tagName,
        id: "",
        className: "",
        dataset: {},
        textContent: "",
        attributes: {},
        classList: {
          classes: new Set(),
          add(value) { this.classes.add(value); },
          remove(value) { this.classes.delete(value); },
          contains(value) { return this.classes.has(value); }
        },
        setAttribute(name, value) {
          this.attributes[name] = value;
        }
      };
    },
    querySelector(selector) {
      return nodes.get(selector) || null;
    }
  };
}

function loadUiMessages(confirmResult = true) {
  const document = createFakeDocument();
  const context = {
    document,
    window: {
      confirm(message) {
        context.confirmedMessage = message;
        return confirmResult;
      }
    },
    confirmedMessage: null,
    timeoutCallback: null,
    setTimeout(fn) {
      context.timeoutCallback = fn;
      return 1;
    },
    clearTimeout() {}
  };
  context.window.setTimeout = context.setTimeout;
  context.window.clearTimeout = context.clearTimeout;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("ui-messages.js", "utf8"), context);
  return context;
}

function testMessageTypesAreNormalized() {
  const context = loadUiMessages();
  assert.equal(context.window.FuelUiMessages.normalizeMessageType("warning"), "warning");
  assert.equal(context.window.FuelUiMessages.normalizeMessageType("bad-type"), "info");
  assert.equal(context.window.FuelUiMessages.normalizeMessageType(null), "info");
}

function testUserErrorsRenderToast() {
  const context = loadUiMessages();
  context.window.showUserError("Could not save");
  const toast = context.document.querySelector("#appMessageToast");
  assert.equal(toast.textContent, "Could not save");
  assert.equal(toast.dataset.type, "error");
  assert.equal(toast.classList.contains("hidden"), false);
}

function testConfirmationUsesNativeConfirmBehindSingleHelper() {
  const context = loadUiMessages(false);
  const ok = context.window.confirmUserAction("Delete this entry?", { title: "Confirm delete" });
  assert.equal(ok, false);
  assert.match(context.confirmedMessage, /Confirm delete/);
  assert.match(context.confirmedMessage, /Delete this entry\?/);
}

for (const test of [
  testMessageTypesAreNormalized,
  testUserErrorsRenderToast,
  testConfirmationUsesNativeConfirmBehindSingleHelper
]) {
  test();
  console.log(`ok - ${test.name}`);
}
