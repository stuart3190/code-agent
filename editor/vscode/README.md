# Thrallo for VS Code

Run Thrallo cloud coding agents from your editor.

1. In the Thrallo web workspace, open **Settings → API tokens** and create a token.
2. In VS Code, run **Thrallo: Connect** and paste the token (stored in VS Code Secret Storage).
3. Open the Thrallo activity-bar view, pick an agent, and describe a task.

The run timeline streams into the **Thrallo** output channel. When changes are ready you
review the diff beside your editor and approve or decline the pull request. Failed runs with
a preserved workspace can be resumed in place.

Package with `npx vsce package` from this directory (no build step — plain JavaScript).
