import { Logo } from "../auth/AuthGate.jsx";

// Public legal pages — /terms, /privacy, /refunds. Rendered BEFORE the auth gate (Stripe and UK
// consumer law require these to be publicly reachable), served by the SPA fallback. Content is
// plain JSX so the pages are self-contained: no fetches, no auth, no state.

export const SUPPORT_EMAIL = "support@buildr101.com";
const UPDATED = "7 July 2026";

export const LEGAL_ROUTES = { "/terms": "terms", "/privacy": "privacy", "/refunds": "refunds" };

export default function LegalPage({ doc }) {
  const Body = { terms: Terms, privacy: Privacy, refunds: Refunds }[doc] ?? Terms;
  return (
    <div className="min-h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <a href="/" className="flex items-center gap-2.5 w-fit">
          <Logo />
          <span className="text-lg font-semibold tracking-tight text-slate-100 font-display">Buildr101</span>
        </a>

        <article className="legal mt-10">
          <Body />
        </article>

        <footer className="mt-12 pt-6 border-t border-line/60 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <a className="hover:text-slate-300" href="/terms">Terms of Service</a>
          <a className="hover:text-slate-300" href="/privacy">Privacy Policy</a>
          <a className="hover:text-slate-300" href="/refunds">Refund Policy</a>
          <a className="hover:text-slate-300" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </footer>
      </div>
    </div>
  );
}

const H1 = ({ children }) => <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{children}</h1>;
const H2 = ({ children }) => <h2 className="text-base font-medium text-slate-100 mt-8">{children}</h2>;
const P = ({ children }) => <p className="text-sm text-slate-400 mt-3 leading-relaxed">{children}</p>;
const UL = ({ children }) => <ul className="text-sm text-slate-400 mt-3 leading-relaxed list-disc pl-5 space-y-1.5">{children}</ul>;
const Updated = () => <p className="text-xs font-mono text-slate-600 mt-2">Last updated: {UPDATED}</p>;
const Support = () => <a className="text-amber-soft hover:underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

function Terms() {
  return (
    <>
      <H1>Terms of Service</H1>
      <Updated />
      <P>
        These terms govern your use of Buildr101 (<span className="text-slate-300">buildr101.com</span>),
        an AI app builder operated from the United Kingdom (&ldquo;Buildr101&rdquo;, &ldquo;we&rdquo;,
        &ldquo;us&rdquo;). By creating an account you agree to them. If you don&rsquo;t agree, don&rsquo;t
        use the service. Questions: <Support />.
      </P>

      <H2>1. The service</H2>
      <P>
        Buildr101 turns plain-English descriptions into working web applications: you describe an app,
        an AI agent builds it, you preview and iterate on it, and you can publish it to a public URL or
        your own domain. AI-generated software is probabilistic — we do not guarantee that any given
        build succeeds, is free of defects, or fits a particular purpose. You are responsible for
        reviewing anything you publish or rely on.
      </P>

      <H2>2. Accounts</H2>
      <P>
        You must be at least 18 and provide accurate information. You are responsible for your account
        credentials and everything done under your account. We may suspend or terminate accounts that
        breach these terms.
      </P>

      <H2>3. Credits, plans and billing</H2>
      <UL>
        <li>Building is metered in <span className="text-slate-300">credits</span>. Credits are a usage
          meter, not money: they are non-transferable, have no cash value, and can&rsquo;t be redeemed.</li>
        <li>New accounts receive a one-time grant of welcome credits, free of charge.</li>
        <li>Paid plans are monthly subscriptions that renew automatically until cancelled. Each cycle
          grants the plan&rsquo;s credit bundle; unused bundle credits roll over only up to a capped
          amount and are otherwise reset at renewal. Top-up credits never expire.</li>
        <li>You can switch or cancel your plan any time in the app; cancellation takes effect at the end
          of the paid period. Refunds are handled per our <a className="text-amber-soft hover:underline" href="/refunds">Refund Policy</a>.</li>
        <li>Payments are processed by Stripe. Prices are shown in GBP and may change; changes never
          apply retroactively to a period you have already paid for.</li>
        <li>If you bring your own API key (BYOK), inference runs on your key and your provider bills
          you directly; we don&rsquo;t debit credits for those builds and we are not responsible for
          your provider&rsquo;s charges.</li>
      </UL>

      <H2>4. Your content and apps</H2>
      <UL>
        <li>You own the apps you build, including the generated code — you can export it at any time.</li>
        <li>You grant us the licence needed to operate the service: storing your projects, running
          previews, and hosting the sites you choose to publish.</li>
        <li>Prompts and project code are processed by third-party AI model providers to perform
          generation (see the <a className="text-amber-soft hover:underline" href="/privacy">Privacy Policy</a>).</li>
        <li>If your app has its own users, <span className="text-slate-300">you</span> are responsible
          for that app and its users&rsquo; data: you are the data controller for your app; we process
          that data on your behalf to host it. Deleting a project deletes its end-user accounts and data.</li>
      </UL>

      <H2>5. Acceptable use</H2>
      <P>You may not use Buildr101 to build, host or distribute:</P>
      <UL>
        <li>anything unlawful, or content that infringes others&rsquo; rights;</li>
        <li>malware, phishing pages, scam or deceptive sites, or spam infrastructure;</li>
        <li>content that is hateful, harassing, or sexualises minors;</li>
        <li>workloads that abuse the platform (e.g. attempting to mine cryptocurrency in previews,
          circumventing metering, probing other users&rsquo; data, or reselling raw access).</li>
      </UL>
      <P>
        We may take down published sites, suspend previews, or terminate accounts that violate this
        section, with notice where practicable.
      </P>

      <H2>6. Availability and changes</H2>
      <P>
        The service is provided &ldquo;as is&rdquo; without a service-level guarantee. Previews sleep
        when idle and wake on use. We may change or discontinue features; if we discontinue the service
        entirely we will give reasonable notice so you can export your apps.
      </P>

      <H2>7. Liability</H2>
      <P>
        Nothing in these terms limits liability that cannot be limited by law (including for death,
        personal injury, or fraud). Otherwise, our total liability to you in any 12-month period is
        capped at the amount you paid us in that period, and we are not liable for indirect or
        consequential losses, lost profits, or lost data — keep exports of anything important. Your
        statutory rights as a consumer are unaffected.
      </P>

      <H2>8. Termination and deletion</H2>
      <P>
        You can delete your account at any time in Settings. Deletion is permanent: it cancels any
        active subscription, takes your published sites offline, and erases your projects, their
        end-user data, and your login. We may terminate accounts for breach of these terms.
      </P>

      <H2>9. General</H2>
      <P>
        We may update these terms; material changes will be announced in the app or by email, and
        continued use after the effective date is acceptance. These terms are governed by the law of
        England and Wales, and its courts have jurisdiction (consumers keep any mandatory protections
        of their home country). Contact: <Support />.
      </P>
    </>
  );
}

function Privacy() {
  return (
    <>
      <H1>Privacy Policy</H1>
      <Updated />
      <P>
        This policy explains what personal data Buildr101 (&ldquo;we&rdquo;) collects, why, and your
        rights over it. We are the data controller for the platform; contact us at <Support />.
      </P>

      <H2>1. What we collect</H2>
      <UL>
        <li><span className="text-slate-300">Account</span> — your email address and a hashed password
          (managed by Supabase, our authentication provider).</li>
        <li><span className="text-slate-300">Content</span> — your projects: prompts, project knowledge,
          generated code, build history, and the sites you publish.</li>
        <li><span className="text-slate-300">Billing</span> — your plan, credit ledger, and Stripe
          customer reference. Card details go directly to Stripe; we never see or store them.</li>
        <li><span className="text-slate-300">BYOK keys</span> — if you save an API key it is stored
          encrypted (AES-256-GCM), is never shown again in full, and is used only to run your builds.</li>
        <li><span className="text-slate-300">Connector credentials and data</span> — connector tokens and
          webhook URLs are encrypted and never shown again. When you allow a read-only connector in the
          builder, the small amount of data it requests is sent to the active AI model provider to complete
          that build. You can disconnect a connector at any time.</li>
        <li><span className="text-slate-300">Technical</span> — server logs (IP address, requests,
          errors) kept for security and debugging.</li>
      </UL>

      <H2>2. Why (lawful bases)</H2>
      <UL>
        <li>Providing the service you signed up for — accounts, building, hosting, billing
          (performance of a contract).</li>
        <li>Securing and improving the platform, preventing abuse (legitimate interests).</li>
        <li>Keeping payment and tax records (legal obligation — held by Stripe).</li>
      </UL>
      <P>We do not sell personal data and we do not run third-party advertising or tracking.</P>

      <H2>3. Who processes it (sub-processors)</H2>
      <UL>
        <li><span className="text-slate-300">Supabase</span> — database, authentication and storage.</li>
        <li><span className="text-slate-300">Stripe</span> — payment processing.</li>
        <li><span className="text-slate-300">OVH</span> — server hosting (EU).</li>
        <li><span className="text-slate-300">Cloudflare</span> — DNS and TLS certificates.</li>
        <li><span className="text-slate-300">AI model providers (OpenAI, Anthropic)</span> — your
          prompts and project code are sent to the model provider serving your build in order to
          generate it. Don&rsquo;t put secrets in prompts.</li>
        <li><span className="text-slate-300">Pexels</span> — image search queries when a build looks
          for photography.</li>
        <li><span className="text-slate-300">Services you connect</span> — such as Google Workspace,
          Slack, Discord, GitHub, Stripe, or a custom API. We contact them only for connections and actions
          you configure, using the permissions you grant.</li>
      </UL>

      <H2>4. Apps you build</H2>
      <P>
        If your published app has its own users, you are the controller of that app&rsquo;s end-user
        data and we process it on your behalf (it lives in your app&rsquo;s namespace in our database).
        Their sign-in credentials are handled the same way as yours. Deleting a project permanently
        deletes its end-user accounts and data; deleting your account deletes all of it.
      </P>

      <H2>5. Retention and deletion</H2>
      <P>
        We keep your data while your account exists. Deleting your account (Settings → Delete account)
        permanently erases your projects, published sites, end-user data, credit ledger, BYOK key and
        login. Records of actual payments are retained by Stripe as required by law. Server logs
        rotate on a short schedule.
      </P>

      <H2>6. Your rights</H2>
      <P>
        Under UK GDPR you can request access to, correction of, or deletion of your personal data,
        object to processing, and ask for a portable copy (the app&rsquo;s export feature covers your
        projects). Write to <Support /> — we respond within one month. You can also complain to the
        UK Information Commissioner&rsquo;s Office (ico.org.uk).
      </P>

      <H2>7. Cookies and local storage</H2>
      <P>
        We use only what sign-in requires: your session token, kept in your browser&rsquo;s local
        storage. No advertising or analytics cookies.
      </P>
    </>
  );
}

function Refunds() {
  return (
    <>
      <H1>Refund Policy</H1>
      <Updated />
      <P>
        Buildr101 sells digital services: subscription plans that grant monthly credit bundles, and
        one-off credit top-ups. This policy sits alongside your statutory rights as a UK/EU consumer,
        which it never reduces. To request a refund, email <Support /> from your account&rsquo;s email
        address.
      </P>

      <H2>Cooling-off (first 14 days)</H2>
      <P>
        You have a 14-day right to cancel a purchase. Because credits are a digital service supplied
        immediately, using credits within those 14 days is a request for immediate performance: if you
        cancel, we refund the price minus the value of the credits you have already used (valued at the
        top-up rate). A purchase with <span className="text-slate-300">no credits used</span> is
        refunded in full.
      </P>

      <H2>Subscriptions</H2>
      <UL>
        <li>Cancel any time in the app — you keep the plan until the end of the period you paid for,
          and it simply doesn&rsquo;t renew. Renewal charges are not refundable once the new
          cycle&rsquo;s credits have been used.</li>
        <li>If a renewal charged you and you haven&rsquo;t used any of that cycle&rsquo;s bundle,
          contact us within 14 days of the charge and we&rsquo;ll refund it.</li>
      </UL>

      <H2>Top-ups</H2>
      <P>Unused top-up credits are refundable within 14 days of purchase. Used credits are not.</P>

      <H2>Faults</H2>
      <P>
        If the service is materially broken — a paid feature genuinely doesn&rsquo;t work, or credits
        were debited by a platform error — tell us and we&rsquo;ll put it right: re-crediting first,
        refund where re-crediting isn&rsquo;t reasonable. This doesn&rsquo;t cover the inherent
        variability of AI generation (a build that needs a few iterations isn&rsquo;t a fault).
      </P>

      <H2>How refunds are paid</H2>
      <P>
        Refunds go to the original payment method via Stripe, normally within 5–10 business days of
        approval.
      </P>
    </>
  );
}
