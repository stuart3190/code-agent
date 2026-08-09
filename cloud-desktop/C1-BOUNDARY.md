# C1 boundary

C1 is a fixture-only visual product prototype. Its state is deterministic and browser-local.

The following are presentation simulations only:

- Thrallo is a placeholder application and contains no Builder V2 or native-desktop code.
- Browser opens only bundled `thrallo://` fixture pages.
- Files never reads or writes a local or cloud filesystem.
- Terminal evaluates an allowlisted in-memory command table and never starts a process.
- GitHub uses static fixture repositories, branches, pull requests, and activity.
- Storage uses deterministic normal, warning, and near-full values.
- Settings persists only fixture desktop preferences and never contacts the portal.

C1 does not contain a cloud runtime, Daytona or Kubernetes integration, authentication,
entitlement enforcement, production networking, upload path, PTY, GitHub OAuth, arbitrary browser,
Builder V2 adapter, or real Thrallo application. Those boundaries remain closed for later packages.
