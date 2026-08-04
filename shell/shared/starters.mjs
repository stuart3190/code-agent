// The starter gallery: expert opening prompts, not templates.
//
// Principle 7 — Thrallo does not ship code templates. A template is someone else's application
// that you then have to bend into yours; every one of these is a PROMPT that goes through the
// ordinary Plan → Build pipeline exactly as if it had been typed. There is no template engine, no
// scaffold branch, and nothing here reaches the builder by a different road than a sentence a
// customer writes themselves.
//
// What makes them expert rather than placeholder:
//
//   1. They name the AUDIENCE and the JOB, because "a CRM" produces a generic CRM and "a CRM for a
//      two-person recruitment agency tracking candidates through stages" produces something usable.
//   2. They state the core entities and the primary screens, so the planner does not have to guess
//      the data model — the single biggest source of a first build that misses.
//   3. They name what NOT to build. Left unsaid, a first build sprawls into settings pages and
//      admin panels nobody asked for and takes three times as long.
//   4. They end with the first thing to get right, so there is an obvious next sentence to send.
//
// Every one of these was run through the real pipeline and revised from what came back; the
// revisions are recorded in docs/STARTERS.md so the next person can see what changed and why.

export const STARTER_CATEGORIES = Object.freeze([
  {
    id: "saas",
    title: "SaaS application",
    icon: "◫",
    description: "A subscription product with accounts, a dashboard and a billing page.",
    outcome: "A working multi-tenant app: sign-in, a dashboard of the customer's own data, and a plan page.",
    prompt:
      "Build a SaaS application for small marketing agencies to track client retainers.\n\n"
      + "Core entities: Client (name, monthly retainer, status), Project (belongs to a client, title, "
      + "hours budgeted, hours used), and TimeEntry (belongs to a project, date, hours, note).\n\n"
      + "Screens I need first:\n"
      + "- A dashboard showing this month's retainer usage per client, with an obvious warning when a "
      + "client is over their budgeted hours.\n"
      + "- A client list I can filter by status, and a client detail page showing their projects.\n"
      + "- A quick 'log time' form that takes under five seconds to use.\n\n"
      + "Do not build a settings area, an admin panel or a marketing site yet.\n\n"
      + "Get the dashboard's over-budget warning right first — that is the reason this exists.",
  },
  {
    id: "landing",
    title: "Landing page",
    icon: "◈",
    description: "A single page that explains one product and asks for one action.",
    outcome: "A fast, responsive page with a clear hero, proof, and one call to action that captures emails.",
    prompt:
      "Build a landing page for a productivity app called Focus that blocks distracting websites "
      + "during timed work sessions.\n\n"
      + "The page needs, in order: a hero that says what it does in one sentence and offers an email "
      + "signup; three benefits with short headings; a section showing how it works in three steps; "
      + "a frequently-asked-questions block; and a footer.\n\n"
      + "The audience is people who already know they get distracted and have tried and abandoned "
      + "other tools, so the copy should acknowledge that rather than sell hard.\n\n"
      + "One call to action only — the email capture — repeated at the top and bottom.\n\n"
      + "Do not build a pricing table, a blog or a login yet.\n\n"
      + "Get the hero right first: it has to make sense to someone who has never heard of this.",
  },
  {
    id: "dashboard",
    title: "Dashboard",
    icon: "▦",
    description: "Numbers that matter, arranged so the important one is unmissable.",
    outcome: "A data dashboard with headline metrics, a trend chart and a filterable table.",
    prompt:
      "Build an operations dashboard for a small e-commerce business owner who checks it once each "
      + "morning.\n\n"
      + "Show, in priority order: revenue today against the same day last week; orders awaiting "
      + "dispatch, which is the number that means someone has to do something; and stock items below "
      + "their reorder level.\n\n"
      + "Below those, a 30-day revenue trend chart, and a table of recent orders I can filter by "
      + "status and search by customer name.\n\n"
      + "Seed it with realistic sample data so the charts are meaningful when I open it.\n\n"
      + "Do not build order editing or customer management yet.\n\n"
      + "Get the 'awaiting dispatch' number right first — it is the one that drives action.",
  },
  {
    id: "crm",
    title: "CRM",
    icon: "◉",
    description: "Track people and deals through stages without a spreadsheet.",
    outcome: "A pipeline board, contact records, and an activity log that shows what happened when.",
    prompt:
      "Build a CRM for a two-person recruitment agency tracking candidates into roles.\n\n"
      + "Core entities: Candidate (name, email, current title, status), Role (client company, title, "
      + "salary range, open/closed), and Application (links a candidate to a role, with a stage).\n\n"
      + "Stages: Applied, Screening, Interview, Offer, Placed, Rejected.\n\n"
      + "Screens I need first:\n"
      + "- A pipeline board of applications by stage that I can drag between columns.\n"
      + "- A candidate detail page with their applications and a chronological activity log.\n"
      + "- A quick-add form for a new candidate that does not demand every field.\n\n"
      + "Do not build email integration, reporting or user permissions yet.\n\n"
      + "Get the drag-between-stages interaction right first — that is the whole daily workflow.",
  },
  {
    id: "booking",
    title: "Booking system",
    icon: "◷",
    description: "Let people book a slot without emailing back and forth.",
    outcome: "A public booking page, availability rules, and an owner view of upcoming bookings.",
    prompt:
      "Build a booking system for a single-location physiotherapy clinic with three practitioners.\n\n"
      + "Core entities: Practitioner (name, specialism), Service (name, duration in minutes, price), "
      + "and Booking (practitioner, service, client name and email, start time, status).\n\n"
      + "Screens I need first:\n"
      + "- A public page where someone picks a service, sees genuinely available slots for the next "
      + "two weeks, and books one.\n"
      + "- An owner view of today and tomorrow's bookings, with a way to cancel.\n\n"
      + "Availability must respect the practitioner's working hours and never offer a slot that "
      + "overlaps an existing booking — double-booking is the failure that makes this useless.\n\n"
      + "Do not build payments, reminders or recurring appointments yet.\n\n"
      + "Get slot availability right first, including the overlap rule.",
  },
  {
    id: "ecommerce",
    title: "Ecommerce",
    icon: "◰",
    description: "A small catalogue and a cart that gets to checkout.",
    outcome: "Product listing, product detail, a working cart, and a checkout summary.",
    prompt:
      "Build an online shop for a small roastery selling eight varieties of coffee beans.\n\n"
      + "Core entities: Product (name, description, tasting notes, roast level, price, image, stock) "
      + "and CartItem (product, quantity, grind option).\n\n"
      + "Screens I need first:\n"
      + "- A shop page listing the beans, filterable by roast level.\n"
      + "- A product page with tasting notes and a grind selector before adding to the cart.\n"
      + "- A cart that persists across a page refresh, and a checkout summary page showing the order "
      + "and total.\n\n"
      + "Stop at the checkout summary — do not take payment details or integrate a payment provider.\n\n"
      + "Do not build accounts, reviews or an admin area yet.\n\n"
      + "Get the cart persisting across a refresh right first; a cart that empties itself is worse "
      + "than no cart.",
  },
  {
    id: "portfolio",
    title: "Portfolio",
    icon: "◇",
    description: "Show work in a way that gets someone hired.",
    outcome: "A homepage, case-study pages with real structure, and a way to get in touch.",
    prompt:
      "Build a portfolio site for a freelance product designer whose visitors are hiring managers "
      + "deciding in under a minute whether to keep reading.\n\n"
      + "Pages I need first:\n"
      + "- A homepage leading with three selected projects, each showing the problem and the outcome "
      + "rather than just a screenshot.\n"
      + "- A case-study page template structured as: context, the problem, what I did, the result, "
      + "and what I would change.\n"
      + "- An about page and a contact form.\n\n"
      + "The design should be restrained and typographic — the work is the decoration.\n\n"
      + "Do not build a blog, a CMS or dark mode yet.\n\n"
      + "Get the case-study structure right first; that is what actually persuades someone.",
  },
  {
    id: "blog",
    title: "Blog",
    icon: "◧",
    description: "Publish writing that is pleasant to read and easy to find.",
    outcome: "An index, readable article pages, tags, and a working search.",
    prompt:
      "Build a blog for someone writing long technical essays, roughly two a month.\n\n"
      + "Screens I need first:\n"
      + "- An index listing posts newest first with title, date, reading time and a one-line summary.\n"
      + "- An article page tuned for long-form reading: a comfortable measure, clear headings, "
      + "readable code blocks, and a table of contents for anything over about 1,500 words.\n"
      + "- Tag pages, and a search over titles and summaries.\n\n"
      + "Seed it with three realistic sample posts of genuinely different lengths so the layout is "
      + "tested by real content.\n\n"
      + "Do not build comments, a newsletter or an admin editor yet.\n\n"
      + "Get the article page's readability right first — everything else is navigation.",
  },
  {
    id: "ai-chat",
    title: "AI chat application",
    icon: "◑",
    description: "A chat interface with history, streaming and a clear purpose.",
    outcome: "A working chat UI with persistent conversations and a defined assistant role.",
    prompt:
      "Build a chat application where a cooking assistant helps someone decide what to make from "
      + "ingredients they already have.\n\n"
      + "Screens I need first:\n"
      + "- A chat interface with a message list, an input, and responses that stream in rather than "
      + "appearing all at once.\n"
      + "- A sidebar of previous conversations that persist across a refresh, each titled from its "
      + "first message.\n\n"
      + "The assistant should ask what ingredients are available before suggesting anything, and "
      + "suggest at most three options with rough timings.\n\n"
      + "Handle the states a chat interface actually has: waiting for a reply, a failed reply with a "
      + "retry, and an empty conversation that explains what to ask.\n\n"
      + "Do not build accounts, sharing or voice input yet.\n\n"
      + "Get the streaming response and the failed-reply retry right first.",
  },
  {
    id: "docs",
    title: "Documentation site",
    icon: "◨",
    description: "Documentation someone can actually navigate.",
    outcome: "A sidebar-navigated docs site with search, code samples and deep-linkable headings.",
    prompt:
      "Build a documentation site for a small open-source JavaScript library that formats dates.\n\n"
      + "Structure I need first:\n"
      + "- A sidebar with sections: Getting started, Guides, API reference.\n"
      + "- Article pages with copyable code blocks and headings that can be linked to directly.\n"
      + "- A search across page titles and headings.\n"
      + "- An on-this-page outline for longer articles.\n\n"
      + "Seed it with a real Getting started page, two guides and three API reference entries so the "
      + "navigation is exercised by actual content.\n\n"
      + "Do not build versioning, internationalisation or a dark-mode toggle yet.\n\n"
      + "Get the sidebar navigation and the copyable code blocks right first.",
  },
]);

// Cheap lookup by id, for the client and for anything that needs to name a starter later.
export function starterById(id) {
  return STARTER_CATEGORIES.find((starter) => starter.id === String(id || "")) || null;
}

/**
 * Which model a starter should run on.
 *
 * Deliberately NOT a per-starter recommendation. The model-selection architecture routes on task
 * shape and on what the owner's plan and connected providers actually allow — a starter claiming
 * "recommended: Opus" would be a promise the router is free to ignore, and on a Free plan or with
 * a BYOK key it frequently would. Auto is the honest answer, and it is what the composer already
 * defaults to, so this returns the same thing rather than inventing a second opinion.
 */
export const STARTER_MODEL_PREF = "auto";
