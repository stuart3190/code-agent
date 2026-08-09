import { APPLICATION_CONTRACT_VERSION } from "./applicationContract.js";

export const applicationRegistry = Object.freeze([]);

export function getApplicationRegistry() {
  return Object.freeze({
    contractVersion: APPLICATION_CONTRACT_VERSION,
    applications: applicationRegistry,
  });
}
