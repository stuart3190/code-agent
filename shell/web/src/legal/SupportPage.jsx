import { useEffect, useState } from "react";
import { Logo } from "../auth/AuthGate.jsx";
import { SUPPORT_EMAIL } from "./LegalPage.jsx";

// Public /support — FAQ + contact. Routed pre-auth in main.jsx like the legal pages, so ad
// traffic with questions never hits a login wall. Answers are held to the same claims bar as
// everything else: nothing promised here that the product doesn't do. Live numbers (welcome
// credits, entry price) come from /api/config — the same source as checkout, never hardcoded.

const FAQS = (cfg) => [
  {
    q: "What is Buildr101?",
    a: `Describe an app or website in plain English and Buildr101 builds the real thing — proper
design, customer accounts, saved data — live in your browser in minutes. You refine it the same
way ("make the header darker", "add prices") and publish it to a live URL when you're ready.`,
  },
  {
    q: "What are build credits?",
    a: `Credits meter the AI work of building. Every new account starts with
${cfg?.welcomeCredits ?? 30} free credits — no card needed. A typical first app plus a few rounds
of changes uses a few dozen credits; small tweaks cost a fraction of a credit. Paid plans refresh
credits monthly, and top-up credits never expire.`,
  },
  {
    q: "Why can't I publish on the free account?",
    a: `Free accounts can build, preview and iterate as far as their credits go. Putting an app on
a live public URL is part of the paid plans (from £${cfg?.tiers?.find((t) => t.id === "starter")?.gbpPerMonth ?? 12}/month).
Unpublishing is never paywalled, and already-published sites keep serving if a subscription lapses.`,
  },
  {
    q: "Can I use my own domain?",
    a: `Yes — custom domains are included on Pro and Studio plans. Publish your app first, then
connect the domain from the Site menu in the builder; you'll get the DNS record to add and HTTPS
is handled automatically.`,
  },
  {
    q: "Do I own what I build?",
    a: `Completely. You can download the full source code of any project at any time from the
builder — if you ever leave, your apps leave with you.`,
  },
  {
    q: "Can I put my app on the Google Play Store?",
    a: `Yes. Once your app is published, open the Site menu in the builder and choose "Download
Android app" — Buildr101 builds you a signed Android app (an APK to install and test right away,
plus an AAB to upload to Play). You upload the AAB to the Play Store under your own Google Play
developer account (a one-time $25 from Google), and keep the included keystore file safe for
future updates. The download includes a README with the exact steps. iOS isn't supported.`,
  },
  {
    q: "Can people install my app on their phone?",
    a: `Yes — every published app is installable. On Android, visitors get an "Install app" prompt
(it becomes a real app with its own icon); on iPhone it's Share → Add to Home Screen. Either way
it opens full-screen with your app's own name and a generated icon, and keeps working on patchy
connections. Nothing to set up — the name and icon are created automatically when you publish.`,
  },
  {
    q: "Can my app have user accounts and saved data?",
    a: `Yes, and it's built in from the first version: your app's visitors can sign up, log in,
reset their password, and their data (bookings, records, uploads) is genuinely saved — no
database setup on your side.`,
  },
  {
    q: "How do refunds and cancellation work?",
    a: `Cancel or switch plans any time in the app — no support ticket needed. Your plan runs to
the end of the paid period. Full details are in the Refund Policy linked below.`,
  },
  {
    q: "How do I delete my account?",
    a: `Settings → Danger zone. Deletion is immediate and complete: your projects, published
sites, data and billing records are erased, and any subscription is cancelled.`,
  },
  {
    q: "Something's broken — what do I do?",
    a: `If a build fails or your preview shows an error, the "Fix it" button sends the error back
to the builder to repair. For anything else — billing issues, stuck builds, questions this page
doesn't answer — email us below and a human will reply.`,
  },
];

export default function SupportPage() {
  const [config, setConfig] = useState(null);
  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => {});
  }, []);

  return (
    <div className="min-h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-lg font-semibold tracking-tight text-slate-100 font-display">Buildr101</span>
          </a>
          <a href="/" className="btn-primary">Start building</a>
        </div>

        <h1 className="mt-12 text-3xl font-semibold tracking-tight text-slate-100 font-display">Support</h1>
        <p className="mt-3 text-sm text-slate-400 max-w-xl leading-relaxed">
          Quick answers to the common questions — and a real person on email for everything else.
        </p>

        <div className="mt-10 space-y-3">
          {FAQS(config).map((f) => (
            <details key={f.q} className="panel px-5 py-4 group">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3 text-sm font-medium text-slate-200">
                {f.q}
                <span className="text-slate-500 transition-transform group-open:rotate-90">›</span>
              </summary>
              <p className="mt-3 text-sm text-slate-400 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>

        <div className="mt-10 panel p-6">
          <div className="text-slate-100 font-medium font-display">Still stuck? Email us.</div>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            <a className="text-amber-soft hover:underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            {" "}— include your account email and, if it's about a build, the project name.
            We aim to reply within one business day.
          </p>
        </div>

        <footer className="mt-12 pt-6 border-t border-line/60 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <a className="hover:text-slate-300" href="/pricing">Pricing</a>
          <a className="hover:text-slate-300" href="/terms">Terms of Service</a>
          <a className="hover:text-slate-300" href="/privacy">Privacy Policy</a>
          <a className="hover:text-slate-300" href="/refunds">Refund Policy</a>
          <a className="hover:text-slate-300" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </footer>
      </div>
    </div>
  );
}
