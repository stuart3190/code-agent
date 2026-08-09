/**
 * C1 application descriptors will conform to this host-neutral shape.
 * C0 deliberately registers no applications.
 *
 * @typedef {object} CloudDesktopApplication
 * @property {string} id
 * @property {string} title
 * @property {string} icon
 * @property {"single"|"multiple"} instancePolicy
 * @property {{ width: number, height: number }} minimumSize
 * @property {readonly string[]} requiredCapabilities
 */

export const APPLICATION_CONTRACT_VERSION = 1;
