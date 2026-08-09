import { ThralloClientError } from "../errors.mjs";
import { parseAuthCallback } from "./deepLink.mjs";

export function findAuthCallbackArgument(argumentsList = []) {
  const callbacks = [];
  for (const value of argumentsList) {
    if (typeof value !== "string" || !value.toLowerCase().startsWith("thrallo:")) continue;
    parseAuthCallback(value);
    callbacks.push(value);
  }
  if (callbacks.length > 1) {
    throw new ThralloClientError("Multiple authentication callbacks were supplied.", { code: "invalid_callback" });
  }
  return callbacks[0] || null;
}

export function createNativeAuthDeepLinkDispatcher({ controller } = {}) {
  if (!controller || typeof controller.handleCallback !== "function") {
    throw new TypeError("Native auth deep-link dispatcher requires an auth controller");
  }
  let queue = Promise.resolve();

  function handleOpenUrl(url) {
    const parsedUrl = String(url);
    parseAuthCallback(parsedUrl);
    const result = queue.catch(() => {}).then(() => controller.handleCallback(parsedUrl));
    queue = result;
    return result;
  }

  async function handleLaunchArguments(argumentsList) {
    const callback = findAuthCallbackArgument(argumentsList);
    return callback ? handleOpenUrl(callback) : null;
  }

  return Object.freeze({ handleOpenUrl, handleLaunchArguments });
}
