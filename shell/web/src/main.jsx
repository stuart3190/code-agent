import React from "react";
import ReactDOM from "react-dom/client";
import ChatShell from "./chat/ChatShell.jsx";
import "@fontsource-variable/manrope";
import "@fontsource-variable/space-grotesk";
import "./index.css";

// One Thrallo. Old /console bookmarks land home.
if (window.location.pathname.startsWith("/console")) {
  window.history.replaceState({}, "", "/");
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ChatShell />
  </React.StrictMode>
);
