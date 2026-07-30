import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import ChatShell from "./chat/ChatShell.jsx";
import "@fontsource-variable/manrope";
import "@fontsource-variable/space-grotesk";
import "./index.css";

// Phase 21: the conversation-first shell is the product at `/`; the existing console
// stays reachable at /console until parity (approved transition decision).
const isConsole = window.location.pathname.startsWith("/console");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isConsole ? <App /> : <ChatShell />}
  </React.StrictMode>
);
