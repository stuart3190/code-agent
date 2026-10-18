# Thrallo for VS Code

Run Thrallo cloud coding agents from your editor.

1. In the Thrallo web workspace, open **Settings → API tokens** and create a token.
2. In VS Code, run **Thrallo: Connect** and paste the token (stored in VS Code Secret Storage).
3. Open the Thrallo activity-bar view, pick an agent, and describe a task.

The run timeline streams into the **Thrallo** output channel. When changes are ready you
review the diff beside your editor and approve or decline the pull request. Failed runs with
a preserved workspace can be resumed in place.

Package with `npx vsce package` from this directory (no build step — plain JavaScript).

### Server connections

Set `thrallo.serverUrl` in user settings; workspace settings cannot override this credential destination. Use an HTTPS origin (no path, query, credentials or fragment). HTTP is supported only for localhost, 127.0.0.1 and ::1 development. Each origin has its own token. Reconnect when moving an older custom-server connection to this version; existing legacy tokens are read only for the default `https://app.thrallo.com` origin. API redirects are refused, so configure the server’s final canonical origin.
