/**
 * C1 application descriptors conform to this host-neutral shape.
 *
 * @typedef {object} CloudDesktopApplication
 * @property {string} id
 * @property {string} title
 * @property {string} icon
 * @property {string} description
 * @property {boolean} pinned
 * @property {boolean} recent
 * @property {{ width: number, height: number, x: number, y: number }} defaultBounds
 * @property {"single"|"multiple"} instancePolicy
 * @property {{ width: number, height: number }} minimumSize
 * @property {readonly string[]} requiredCapabilities
 */

export const APPLICATION_CONTRACT_VERSION = 1;
