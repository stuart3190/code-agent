import { useEffect, useRef, useState } from "react";
import { AuthCard, Logo } from "../auth/AuthGate.jsx";
import showcase from "../assets/showcase-barber2.jpg";

// The logged-out experience — a real landing page, not a login box. The signature element is the
// BUILD CONSOLE: on load it types a real starter prompt, streams build-log lines (the same
// vocabulary as the actual builder timeline), then the browser frame beneath resolves into the
// untouched screenshot of the app those words produced. The product's core moment, played once.
// Mono type is the machine's voice (prompts, logs, URLs); Grotesk/Manrope is ours.
// Auth logic lives untouched in AuthCard; `mode` is lifted here so the nav can drive it.

// The exact prompt and build the screenshot came from (harness/_images-probe.mjs, 2026-07-16) —
// "Built from that sentence. Untouched." has to stay literally true.
const PROMPT = "a website for a local barber shop: hero, services with prices, opening hours, about the shop, and a booking request form";
const LOG_LINES = [
  "scaffold ready — React + Tailwind",
  "search_images: \"barber shop haircut…\" — 8 real photos",
  "writing src/App.jsx — hero, services, hours, booking",
  "published → ironandoak.app.buildr101.com",
];

export default function Landing() {
  const [mode, setMode] = useState("signup");
  const cardRef = useRef(null);

  function goToCard(nextMode) {
    setMode(nextMode);
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div className="min-h-full overflow-y-auto overflow-x-hidden">
      {/* ── nav ─────────────────────────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-line/40 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <a href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="font-display text-lg font-semibold tracking-tight text-slate-100">Buildr101</span>
          </a>
          <nav className="flex items-center gap-1 sm:gap-2">
            <a href="#how" className="hidden sm:block rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200">How it works</a>
            <a href="/pricing" className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200">Pricing</a>
            <button className="btn-ghost !py-1.5" onClick={() => goToCard("signin")}>Sign in</button>
          </nav>
        </div>
      </header>

      {/* ── hero ────────────────────────────────────────────────────────────────────────────── */}
      <section className="relative">
        <div aria-hidden className="landing-grid pointer-events-none absolute inset-0" />
        <div className="relative mx-auto grid max-w-6xl grid-cols-1 items-start gap-10 px-5 pb-16 pt-12 sm:pt-16 lg:grid-cols-[1.15fr_minmax(0,24rem)] lg:gap-14 lg:pb-24">
          <div className="order-1 min-w-0 lg:col-start-1 lg:row-start-1">
            <h1 className="font-display text-[2.6rem] font-semibold leading-[1.04] tracking-tight text-slate-100 sm:text-6xl">
              Describe an app.<br />
              Watch it <span className="text-amber">build</span>.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-400">
              Type what you want in plain English. Buildr101 builds a working web app — accounts,
              saved data, real design — and puts it live on a link you can share.
            </p>
            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-slate-400">
              <Chip>30 free credits</Chip>
              <Chip>No card needed</Chip>
              <Chip>Your code is yours</Chip>
            </ul>
          </div>

          <div ref={cardRef} className="order-3 min-w-0 justify-self-center w-full max-w-sm lg:order-2 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:justify-self-end">
            <AuthCard mode={mode} onMode={setMode} />
            <p className="mt-3 text-center text-[11px] text-slate-600">
              By continuing you agree to the <a className="underline hover:text-slate-400" href="/terms">Terms</a> and{" "}
              <a className="underline hover:text-slate-400" href="/privacy">Privacy Policy</a>.
            </p>
          </div>

          <div className="order-2 min-w-0 lg:order-3 lg:col-start-1 lg:row-start-2">
            <BuildConsole />
          </div>
        </div>
      </section>

      {/* ── how it works — a real sequence, so the numbers mean something ───────────────────── */}
      <section id="how" className="border-t border-line/40">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
            From sentence to live app
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <Step n="01" title="Describe">
              Say what you want — “a booking site for my barber shop”. The first working version
              appears in minutes, not mockups.
            </Step>
            <Step n="02" title="Refine">
              Ask for changes the same way: “make the header darker”, “add prices”. Every build is a
              version you can roll back.
            </Step>
            <Step n="03" title="Publish">
              One click puts it at <span className="font-mono text-[0.92em] text-amber-soft">yourname.app.buildr101.com</span> —
              or connect your own domain.
            </Step>
          </div>
        </div>
      </section>

      <Showcase />

      {/* ── what you get ────────────────────────────────────────────────────────────────────── */}
      <section className="border-t border-line/40">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
            A real app, not a demo
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Feature icon={<IconUsers />} title="Accounts and data built in">
              Sign-ins, saved records and file uploads are wired in from the first version — your
              users' data persists without you touching a database.
            </Feature>
            <Feature icon={<IconPalette />} title="Design that holds up">
              Every app gets a real type and color system with real photography — not the look
              people mean when they say “AI-generated”.
            </Feature>
            <Feature icon={<IconGlobe />} title="Live on the web — and on phones">
              Publish to your own corner of the internet on any paid plan, custom domains on Pro.
              Every published app installs on phones like a real app — icon, full screen, the lot.
            </Feature>
            <Feature icon={<IconDownload />} title="No lock-in">
              Download the complete source code of anything you build, any time. If you leave, your
              apps leave with you.
            </Feature>
          </div>
        </div>
      </section>

      {/* ── pricing teaser — live numbers from the same source as checkout ──────────────────── */}
      <PricingStrip onStart={() => goToCard("signup")} />

      {/* ── final push ──────────────────────────────────────────────────────────────────────── */}
      <section className="border-t border-line/40">
        <div className="mx-auto max-w-6xl px-5 py-16 text-center lg:py-24">
          <h2 className="font-display text-3xl font-semibold tracking-tight text-slate-100 sm:text-4xl">
            Your first app is one sentence away.
          </h2>
          <button className="btn-primary mt-7 !px-6 !py-2.5 !text-base" onClick={() => goToCard("signup")}>
            Start building free
          </button>
          <p className="mt-3 text-xs text-slate-500">30 credits included · no card needed</p>
        </div>
      </section>

      {/* ── footer ──────────────────────────────────────────────────────────────────────────── */}
      <footer className="border-t border-line/40">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-8 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <Logo className="!h-5 !w-5" />
            <span className="text-slate-400">© {new Date().getFullYear()} Buildr101</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <a className="hover:text-slate-300" href="/pricing">Pricing</a>
            <a className="hover:text-slate-300" href="/support">Support</a>
            <a className="hover:text-slate-300" href="/terms">Terms</a>
            <a className="hover:text-slate-300" href="/privacy">Privacy</a>
            <a className="hover:text-slate-300" href="/refunds">Refunds</a>
            <a className="hover:text-slate-300" href="mailto:support@buildr101.com">support@buildr101.com</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Showcase() {
  return (
    <section className="border-t border-stone-300 bg-[#f2eee6] text-stone-900">
      <div className="mx-auto max-w-6xl px-5 py-16 lg:py-24">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-700">Not one tired template</div>
            <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold leading-tight tracking-tight text-stone-950 sm:text-5xl">
              Different ideas should look different.
            </h2>
          </div>
          <p className="max-w-md text-sm leading-relaxed text-stone-600 sm:text-right">
            A local business, a serious SaaS workspace and a consumer app need different composition,
            type and personality. Buildr101 art-directs for the product you describe.
          </p>
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-12 lg:grid-rows-2">
          <article className="group overflow-hidden rounded-[1.35rem] bg-stone-950 p-2 shadow-[0_24px_60px_rgba(28,25,23,0.18)] lg:col-span-7 lg:row-span-2">
            <div className="flex items-center justify-between px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-stone-400">
              <span>Local business</span><span className="text-amber-soft">Editorial warmth</span>
            </div>
            <div className="relative aspect-[16/10] overflow-hidden rounded-xl bg-stone-900">
              <img src={showcase} alt="A warm editorial barber shop site generated by Buildr101"
                className="h-full w-full object-cover object-top transition duration-700 group-hover:scale-[1.02]" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-stone-950/90 to-transparent px-5 pb-4 pt-14 text-white">
                <div className="font-display text-lg font-semibold">Iron &amp; Oak Barber Co.</div>
                <div className="mt-1 text-xs text-stone-300">Photography-led service site · booking journey · opening hours</div>
              </div>
            </div>
          </article>

          <article className="overflow-hidden rounded-[1.35rem] border border-stone-300 bg-white p-4 shadow-[0_16px_40px_rgba(28,25,23,0.09)] lg:col-span-5">
            <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              <span>SaaS workspace</span><span className="text-indigo-600">Quiet precision</span>
            </div>
            <div className="mt-4 grid aspect-[16/7] grid-cols-[3.4rem_1fr] overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              <div className="border-r border-slate-200 bg-slate-950 p-2.5">
                <div className="h-5 w-5 rounded-md bg-indigo-500" />
                <div className="mt-5 space-y-2.5">{["w-7", "w-5", "w-6", "w-4"].map((w, i) => <div key={i} className={`h-1.5 ${w} rounded bg-slate-700`} />)}</div>
              </div>
              <div className="p-3 sm:p-4">
                <div className="flex items-center justify-between"><div><div className="h-2 w-20 rounded bg-slate-800" /><div className="mt-1.5 h-1.5 w-28 rounded bg-slate-300" /></div><div className="h-6 w-16 rounded-md bg-indigo-600" /></div>
                <div className="mt-4 grid grid-cols-3 gap-2">{["38.4k", "12.8%", "1,284"].map((value, i) => <div key={value} className="rounded-lg border border-slate-200 bg-white p-2"><div className="text-[7px] uppercase text-slate-400">{["Revenue", "Conversion", "Customers"][i]}</div><div className="mt-1 text-xs font-bold text-slate-900 sm:text-sm">{value}</div></div>)}</div>
                <div className="mt-3 flex h-10 items-end gap-1 rounded-lg border border-slate-200 bg-white px-2 pb-1.5">{[28, 44, 34, 58, 48, 70, 62, 84, 72, 92].map((h, i) => <div key={i} className="flex-1 rounded-t-sm bg-indigo-500/80" style={{ height: `${h}%` }} />)}</div>
              </div>
            </div>
          </article>

          <article className="overflow-hidden rounded-[1.35rem] bg-[#173d32] p-4 text-white shadow-[0_16px_40px_rgba(28,25,23,0.12)] lg:col-span-5">
            <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100/65">
              <span>Consumer app</span><span className="text-[#f5c76b]">Friendly energy</span>
            </div>
            <div className="mt-4 grid aspect-[16/7] grid-cols-[1fr_7rem] items-center gap-4 overflow-hidden rounded-xl bg-[#1f5142] px-5 sm:grid-cols-[1fr_8.5rem]">
              <div><div className="font-display text-2xl font-semibold leading-none sm:text-3xl">Make tonight<br />taste better.</div><div className="mt-2 max-w-52 text-[10px] leading-relaxed text-emerald-100/70">Plan a seasonal meal from what is already in your kitchen.</div><div className="mt-3 inline-flex rounded-full bg-[#f5c76b] px-3 py-1.5 text-[9px] font-bold text-[#173d32]">Create a menu</div></div>
              <div className="rotate-3 rounded-[1.4rem] bg-[#f7f1df] p-2 shadow-xl"><div className="aspect-[4/5] rounded-[1rem] bg-[radial-gradient(circle_at_70%_25%,#f5c76b_0_12%,transparent_13%),linear-gradient(145deg,#dceccf,#f7f1df)] p-2"><div className="h-1.5 w-10 rounded bg-[#173d32]/70" /><div className="mt-12 rounded-lg bg-white/80 p-2"><div className="h-1.5 w-12 rounded bg-[#173d32]/80" /><div className="mt-1 h-1 w-16 rounded bg-[#173d32]/20" /></div></div></div>
            </div>
          </article>
        </div>
        <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-stone-300 pt-5 text-xs text-stone-500">
          <span>Art direction changes with the brief—not a template picker wearing new colours.</span>
          <button className="font-semibold text-stone-900 underline decoration-amber-500 decoration-2 underline-offset-4" onClick={() => document.querySelector("input[type='email']")?.focus()}>Build your version</button>
        </div>
      </div>
    </section>
  );
}

/* ── the signature: prompt in, build log, live app out ─────────────────────────────────────── */

function BuildConsole() {
  const reduced = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [typed, setTyped] = useState(reduced ? PROMPT : "");
  const [lines, setLines] = useState(reduced ? LOG_LINES.length : 0);
  const [done, setDone] = useState(reduced);

  useEffect(() => {
    if (reduced) return;
    const timers = [];
    const t = (fn, ms) => timers.push(setTimeout(fn, ms));
    // Type the prompt…
    for (let i = 1; i <= PROMPT.length; i++) t(() => setTyped(PROMPT.slice(0, i)), 350 + i * 22);
    const typedDone = 350 + PROMPT.length * 22;
    // …stream the log…
    LOG_LINES.forEach((_, i) => t(() => setLines(i + 1), typedDone + 500 + i * 620));
    // …and resolve the frame into the real app.
    t(() => setDone(true), typedDone + 500 + LOG_LINES.length * 620 + 250);
    return () => timers.forEach(clearTimeout);
  }, [reduced]);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-ink-900 shadow-panel">
      {/* terminal: the sentence going in */}
      <div className="border-b border-line bg-ink-850/60 px-4 pb-4 pt-3 font-mono text-[13px] leading-relaxed">
        <div className="mb-2 flex items-center gap-1.5">
          <Dot /><Dot /><Dot />
          <span className="ml-2 text-[11px] text-slate-600">buildr101 — new app</span>
        </div>
        <div className="text-slate-500">describe your app:</div>
        <div className="min-h-[2.6em] text-slate-100 sm:min-h-[1.3em]">
          {typed}
          {!done && <span className="landing-caret ml-0.5 inline-block h-[1.1em] w-[7px] translate-y-[2px] bg-amber" />}
        </div>
        <div aria-live="polite">
          {LOG_LINES.slice(0, lines).map((l) => (
            <div key={l} className="landing-rise mt-1.5 flex gap-2 text-slate-400">
              <span className="text-amber">✓</span>
              <span className="min-w-0 break-words">{l}</span>
            </div>
          ))}
        </div>
      </div>

      {/* browser: the app coming out — the screenshot is a real build, untouched */}
      <div className="flex h-8 items-center gap-1.5 border-b border-line bg-ink-850 px-3">
        <Dot /><Dot /><Dot />
        <span className={`ml-2 truncate font-mono text-[11px] transition-colors duration-500 ${done ? "text-amber-soft" : "text-slate-600"}`}>
          ironandoak.app.buildr101.com
        </span>
      </div>
      <div className="relative h-64 sm:h-80">
        <div className={`absolute inset-0 space-y-3 p-5 transition-opacity duration-700 ${done ? "opacity-0" : "opacity-100"}`} aria-hidden>
          <div className="h-5 w-2/5 animate-pulse rounded bg-ink-800" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-ink-800" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-ink-800" />
          <div className="mt-6 grid grid-cols-3 gap-3">
            <div className="h-20 animate-pulse rounded bg-ink-800" />
            <div className="h-20 animate-pulse rounded bg-ink-800" />
            <div className="h-20 animate-pulse rounded bg-ink-800" />
          </div>
        </div>
        <img src={showcase} alt="Iron & Oak Barber Co. — a barber shop website Buildr101 built from the sentence above: real photography hero, services with prices, and a booking form"
          className={`h-full w-full object-cover object-top transition-opacity duration-700 ${done ? "opacity-100" : "opacity-0"}`} />
      </div>
      <div className="border-t border-line bg-ink-850/60 px-4 py-2 font-mono text-[11px] text-slate-600">
        Built from that sentence. Untouched.
      </div>
    </div>
  );
}

/* ── pricing strip ──────────────────────────────────────────────────────────────────────────── */

function PricingStrip({ onStart }) {
  const [config, setConfig] = useState(null);
  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => {});
  }, []);
  const tiers = (config?.tiers || []).filter((t) => t.managed);

  return (
    <section className="border-t border-line/40">
      <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
              Start free. Publish from £12 a month.
            </h2>
            <p className="mt-2 max-w-xl text-sm text-slate-400">
              Building is metered in credits. The free account includes
              {config?.welcomeCredits ? ` ${config.welcomeCredits}` : ""} credits — enough to build
              and preview your first apps before paying anything.
            </p>
          </div>
          <a href="/pricing" className="text-sm text-amber-soft hover:underline">See full pricing →</a>
        </div>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TierCard name="Free" price="£0" note={`${config?.welcomeCredits ?? 30} welcome credits`} cta="Create account" onStart={onStart} />
          {tiers.map((t) => (
            <TierCard key={t.id} name={t.name} price={`£${t.gbpPerMonth}`} per="/mo" highlight={t.id === "pro"}
              note={`${t.bundledCredits.toLocaleString()} credits monthly`} cta={`Get ${t.name}`} onStart={onStart} />
          ))}
        </div>
      </div>
    </section>
  );
}

function TierCard({ name, price, per, note, cta, highlight, onStart }) {
  return (
    <div className={`panel flex flex-col p-5 ${highlight ? "border-amber/50" : ""}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-200">{name}</span>
        {highlight && <span className="tag bg-amber/15 text-amber-soft">Popular</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="font-display text-2xl font-semibold tracking-tight text-slate-100">{price}</span>
        {per && <span className="text-xs text-slate-500">{per}</span>}
      </div>
      <div className="mb-4 mt-1 flex-1 text-xs text-slate-400">{note}</div>
      <button className={highlight ? "btn-primary" : "btn-ghost"} onClick={onStart}>{cta}</button>
    </div>
  );
}

/* ── small parts ───────────────────────────────────────────────────────────────────────────── */

function Chip({ children }) {
  return (
    <li className="flex items-center gap-1.5">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f5a623" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
      {children}
    </li>
  );
}

function Step({ n, title, children }) {
  return (
    <div className="panel p-5">
      <div className="font-mono text-[11px] tracking-widest text-amber">{n}</div>
      <div className="mt-2 font-display text-base font-semibold text-slate-100">{title}</div>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{children}</p>
    </div>
  );
}

function Feature({ icon, title, children }) {
  return (
    <div className="panel flex gap-4 p-5">
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-ink-850 text-amber">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-display text-base font-semibold text-slate-100">{title}</div>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">{children}</p>
      </div>
    </div>
  );
}

function Dot() { return <span className="h-2.5 w-2.5 rounded-full bg-ink-700" />; }

const ico = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
function IconUsers() {
  return (<svg {...ico}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg>);
}
function IconPalette() {
  return (<svg {...ico}><path d="M12 22a10 10 0 110-20 10 9 0 0110 9 5 5 0 01-5 5h-2.2a1.8 1.8 0 00-1.4 2.9 1.8 1.8 0 01-1.4 3.1z" /><circle cx="7.5" cy="10.5" r=".8" /><circle cx="12" cy="7.5" r=".8" /><circle cx="16.5" cy="10.5" r=".8" /></svg>);
}
function IconGlobe() {
  return (<svg {...ico}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" /></svg>);
}
function IconDownload() {
  return (<svg {...ico}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>);
}
