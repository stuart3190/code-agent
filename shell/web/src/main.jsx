import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import LegalPage, { LEGAL_ROUTES } from "./legal/LegalPage.jsx";
import "@fontsource-variable/manrope";
import "@fontsource-variable/space-grotesk";
import "./index.css";

// Public legal pages (/terms, /privacy, /refunds) — reachable without an account (Stripe and
// consumer law require public URLs). Routed here so App and its auth state never load for them.
const legalDoc = LEGAL_ROUTES[window.location.pathname];

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {legalDoc ? <LegalPage doc={legalDoc} /> : <App />}
  </React.StrictMode>
);
