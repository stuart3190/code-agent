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

// Apply the stored theme before first paint — no flash, and every surface (boot splash
// included) renders in the chosen theme. Light is the default.
try {
  const themePref = localStorage.getItem("thrallo-theme");
  if (themePref === "dark" ||
      (themePref === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.dataset.theme = "dark";
  }
} catch { /* storage unavailable — light default stands */ }

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ChatShell />
  </React.StrictMode>
);
