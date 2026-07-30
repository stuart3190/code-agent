# Thrallo Product Principles

> Source of truth for every implementation decision, approved by Stuart on 2026-07-30
> alongside the v2 roadmap. Any proposed architecture change must be justified against this
> document before being made.

## Mission

Thrallo is an AI Software Engineering Platform combining autonomous AI agents, Code OSS, and
conversational software engineering. **The user explains what they want. Thrallo decides how
to build it.**

## The Twelve Principles

1. **Conversation is the operating system.** The user almost never navigates menus.
   "Build me a booking system." / "Publish it." / "Add Stripe." / "Make it blue." /
   "Deploy it." / "Fix the login." — the AI determines implementation details automatically.
2. **Never ask technical questions unless absolutely necessary.** Never ask React-or-Vue,
   which database, auth provider, hosting, folder structure. Thrallo decides. Only questions
   that affect the actual business outcome.
3. **Every permanent button must justify its existence.** Permanent UI stays minimal:
   Conversation, Agent sidebar, Settings, Preview. Everything else appears only when
   relevant.
4. **Agents feel like a real software team.** Specialists visibly working in real time
   ("Lead Agent ✓ Understanding request → Planner: Planning architecture… → Designer:
   Creating UI… → Database: Designing schema… → Builder: Writing frontend… → Tester: Running
   tests… → Publisher: Preparing preview…"). Managing a team, not filling a form.
5. **Preview-first workflow.** Anything visual appears as a preview inside the conversation
   the moment it is ready; the conversation stays the centre of the experience.
6. **Feels like ChatGPT, not an admin dashboard.** Large whitespace, light theme by default,
   very few permanent controls, premium typography, minimal distractions; the conversation
   occupies most of the screen.
7. **Builds outcomes, not projects.** No templates. Thrallo decides whether the outcome is a
   web app, mobile app, desktop app, game, API, AI agent, SDK, browser extension, or another
   appropriate solution.
8. **Context is permanent.** The Lead Agent remembers the user's product, branding, previous
   conversations, coding style, deployment preferences. The user never repeats themselves.
9. **Every feature feels like magic.** Anticipate obvious next steps where appropriate —
   the user should constantly think "I didn't even have to ask for that."
10. **Simplicity wins every argument.** Settings page vs menu vs button vs asking the Lead
    Agent: conversation always wins.
11. **The Lead Agent owns the relationship; specialist agents are disposable.** Planner,
    Designer, Builder, Tester come and go per task — the Lead Agent never dies. The
    conversation always remains with one AI, like ChatGPT, never like swapping assistants.
12. **The product continuously improves itself.** The Lead Agent actively identifies
    friction, repetition, and opportunities for improvement while working. When it discovers
    a better workflow, prompt, UI interaction, capability, or automation aligned with the
    product vision, it surfaces the improvement or implements it where appropriate. Thrallo
    doesn't only build software — it continuously evolves itself into a better software
    engineer, becoming more capable over time without accumulating unnecessary complexity.

## Implementation Emphases (the north star)

**"I don't want to build another AI app builder. I want to build the product that makes
every other AI app builder feel old-fashioned. Every implementation decision should move
towards that goal."**

- **The product must feel alive.** Specialists appear naturally as work begins, stream what
  they're doing in plain English, and disappear when finished — a real software team, never
  a loading spinner.
- **Push autonomy as far as possible.** "Build me a booking system" → framework, database,
  auth, deployment, testing all decided automatically; only genuine business decisions reach
  the user.
- **The preview is the hero.** Conversation flows into a live preview without being asked;
  every build feels like watching software created in real time.
- **Obsess over removing UI.** Conversation-triggerable ⇒ no button; every permanent
  control must justify its existence.
- **Premium over features.** Smooth animations, streaming responses, subtle transitions,
  live status, excellent typography outrank another feature.
- **Surprise me.** If the obvious next step is known, do it — don't wait for instructions
  any experienced engineer could predict.
- **Keep asking "Can this be simpler?"** If yes, simplify. And **"Would this delight the
  user?"** — if yes and it doesn't conflict with the core principles, build it. Create
  moments where users think, "I didn't know it could do that."

These emphases are acceptance criteria for every phase review, alongside the tests.

## Platform Architecture

Eight systems form the skeleton every phase builds against. They exist so that adding a
capability NEVER means changing the Lead Agent.

1. **Capability Registry** — every Thrallo ability is a registered capability:
   `{ id, description, specialist, inputSchema, costProfile, requirements, invoke() }`.
   The Lead Agent's tool list is GENERATED from the registry — zero hardcoded decisions.
   Registering a new capability makes it available automatically, in the same deploy.
2. **Tool/Plugin System** — capabilities are plugins, not core code (Stripe, Supabase,
   React, Electron, Shopify, Docker, Roblox, Unity, Android, Apple…). Hundreds of abilities
   must not mean hundreds of special cases.
3. **Memory System** — layered permanent context: (a) owner profile (coding style, colours,
   frameworks, naming, auth/deployment preferences, companies), (b) product memory
   (per-product branding/decisions/state — the unit of multi-project awareness),
   (c) episodic memory (distilled conversation summaries, searchable months later).
   Injected by relevance into every Lead Agent turn.
4. **Project (Product) Context** — the Lead Agent knows the user's products by name, infers
   which one a message refers to ("continue working on yesterday's booking app"), and never
   requires a project switcher.
5. **Notification System** — when the user is away: "Preview ready." "Tests failed."
   "Deploy complete." — browser/web push, desktop, email; one dispatch service with
   per-channel adapters; preferences learned conversationally, not a settings matrix.
6. **Lead Agent lifecycle** — a durable per-owner entity (persona + memory + open
   conversations) that never restarts from the user's perspective; specialists are ephemeral
   workers it spawns and discards. Crash/deploy recovery restores it seamlessly
   mid-conversation via durable event replay.
7. **Approval surfaces** — approvals are natural in-thread cards, never "Continue?":
   a preview card with [Publish]; "Database changes detected → Approve".
8. **Future Marketplace** — not built yet, but the registry/plugin contracts are its API:
   an installable "Shopify Expert" is a plugin bundle (capabilities + specialist persona +
   knowledge) that registers itself. Nothing may assume a closed capability set.
