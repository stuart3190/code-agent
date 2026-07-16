import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import LegalPage, { LEGAL_ROUTES } from "./legal/LegalPage.jsx";
import PricingPage from "./legal/PricingPage.jsx";
import SupportPage from "./legal/SupportPage.jsx";
import "@fontsource-variable/manrope";
import "@fontsource-variable/space-grotesk";
import "./index.css";

// Public pages (/pricing, /terms, /privacy, /refunds) — reachable without an account (Stripe and
// consumer law require public URLs). Routed here so App and its auth state never load for them.
const path = window.location.pathname;
const legalDoc = LEGAL_ROUTES[path];
const publicPage = path === "/pricing" ? <PricingPage />
  : path === "/support" ? <SupportPage />
  : legalDoc ? <LegalPage doc={legalDoc} /> : null;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {publicPage ?? <App />}
  </React.StrictMode>
);
