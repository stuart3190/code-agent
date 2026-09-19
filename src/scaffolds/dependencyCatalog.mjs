// Packages that generated applications may rely on inside the network-isolated build sandbox.
//
// The sandbox compiles with --network none and a read-only, preinstalled node_modules tree. A
// package is therefore supported only when it is pinned here and baked into the same scaffold
// manifest the compiler image installs. This is deliberately a small capability catalogue, not
// permission for generated code to fetch arbitrary install scripts at build time.

export const GENERATED_DEPENDENCY_CATALOG = Object.freeze([
  Object.freeze({
    capability: "browser_3d",
    package: "three",
    version: "0.185.1",
    role: "genuine browser WebGL scene rendering, camera controls and object picking",
    signals: Object.freeze([
      "3d", "webgl", "orbit", "camera controls", "scene rendering", "object picking",
      "interactive model geometry",
    ]),
  }),
]);

export const GENERATED_DEPENDENCIES = Object.freeze(Object.fromEntries(
  GENERATED_DEPENDENCY_CATALOG.map((entry) => [entry.package, entry.version]),
));
