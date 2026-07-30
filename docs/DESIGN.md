# Thrallo Design — Phase 20 experience brief

> Status: awaiting Stuart's wireframe approval (the Phase 20 gate). Nothing here touches the
> production UI; the clickable prototype ships at `/design/` (unlinked), tokens at
> `shell/web/src/theme/tokens.css`. Phase 21 builds exactly what is approved here.

Every decision below is judged against `docs/PRINCIPLES.md`. The test applied to every
element was: *would ChatGPT need this? Does it exist only because traditional software has
one? Can a sentence to the Lead Agent replace it?* If yes to either of the last two, it was
removed.

## The one-sentence experience

**You talk to one intelligence that runs a software team for you; the room changes around
the conversation as work happens.**

Not "an app builder with a chat feature". The conversation is the operating system
(Principle 1); everything else — the team, the preview, the approvals — is the room
responding to what's happening in it.

## The permanent surface (exactly four, Principle 3)

1. **Conversation** — a single centred column (~720px max) on a soft warm canvas. This is
   the whole product at rest.
2. **Agent sidebar** — the *living rail* on the right. Crucially: **it does not exist until
   there is a team.** On a fresh conversation the rail is empty canvas. When the Lead Agent
   spawns its first specialist the rail fades in; when a preview arrives the rail becomes
   the preview and the team collapses to a compact strip above it. One surface, three
   states (empty → team → team + preview) — not three widgets.
3. **Preview** — the hero (Principle 5). It is the rail's third state on desktop and a
   full-screen sheet on mobile. Chrome-less frame, a URL pill, and exactly one natural
   action: **Publish**. Refinement is conversational ("make it blue") — there are no edit
   toolbars.
4. **Settings** — one quiet avatar top-right opening a *sheet* (never a navigation): the
   things that are genuinely credentials/plumbing — account, AI connection (BYOK), plan &
   budgets, API tokens, appearance. Budget *questions* are answered in conversation
   (Principle 10); the sheet only holds what conversation cannot safely do (secrets).

Top bar: wordmark left, product-context pill centre (only when a product is in play),
settings avatar right. There is no navigation because there is nowhere else to go.

## The moments (what Phase 21 must reproduce)

### 1 · Begin
A calm, almost-empty page. A time-aware greeting in display type ("Morning, Stuart."), one
question — **"What should we build?"** — one beautiful input, and up to three
memory-grounded chips ("Continue FocusFlow", "Something new"). No dashboard, no project
list, no cards. Memory (Principle 8) is why chips can be this personal; the command palette
(⌘K) is where old conversations/products are searched — never a permanent list.

### 2 · The team assembles (Principle 4, the "human feel")
The Lead Agent replies in streaming plain English and commits to the work. Specialists
appear in the rail **sequentially, as their stage begins** — avatar, name, one human status
line ("Creating the design system…"), a soft working shimmer; on completion a ✓ settles
them into a dimmed roster. The Lead Agent is pinned at the top of the rail and never leaves
(Principle 11 — specialists are disposable, the relationship is not). In-thread, a compact
**plan card** (outcome-focused steps, no jargon) ticks off as phases pass. Progress is
narrated sparsely — a team keeping you informed, not a log file.

### 3 · Preview is the hero (Principle 5)
The moment the preview exists, a preview card slides into the thread unprompted *and* the
rail glides into preview state. The card carries the natural next step — **Publish** — as
an in-card action (approval surfaces, Platform Architecture 7), never a "Continue?".
Publishing resolves the card into a receipt line ("Live at focusflow.thrallo.app ↗") that
stays in history. Anticipation (Principle 9): the Lead Agent offers the obvious next step
("Want a proper domain?") without being asked.

### 4 · Everything else is conversation (Principles 1/2/10)
"What's running?" and "how much budget is left?" are chat turns with tiny inline visuals
(a budget bar inside the reply), not screens. Questions from Thrallo are rare, business-only
(Principle 2), and arrive as a distinct **question card** with tappable answer chips.
Database/schema changes arrive as an **approval card** with a plain-English summary. Cards
resolve in place and collapse into history.

### 5 · Away and back (Platform Architecture 5)
When the user is away, finishing work becomes an OS notification ("Preview ready —
FocusFlow"). Returning lands in the conversation exactly as it was left; the Lead Agent
speaks first ("While you were away…"). No inbox, no badge counts.

### 6 · Mobile is the same product, not a compressed one
Single column; the team is a slide-down strip under the top bar; the preview is a
full-screen sheet with a grab-handle back to the chat; input pinned to the bottom. All four
permanent elements survive; nothing extra appears.

### 7 · Power, hidden (⌘K)
One command palette: publish, new conversation, switch product, search memory, settings.
Doesn't count against the permanent four; invisible until summoned.

## Visual language (the tokens, in words)

- **Light by default** (dark available). Canvas `#FAFAF8` — warm, paper-like; pure white
  cards; ink `#1B1826`.
- **One accent** — Thrallo violet `#6A5AE0` — used for the Lead Agent, primary actions and
  focus. Specialists carry their own quiet identity hues (Planner sky, Designer pink,
  Builder amber, Tester green, Publisher indigo) so the team feels like people, not icons.
- **Type**: Space Grotesk for display moments (the greeting), Manrope for everything else.
  Body 15.5/1.6. Micro-labels are letterspaced small caps.
- **Shape**: soft — 14px bubbles, 18px cards, 24px panes.
- **Motion is the product feeling alive**: 150/240/420ms; standard decel ease plus a gentle
  spring for anything that *arrives* (specialists, cards, preview). Nothing bounces twice.
- **Depth**: layered soft shadows, no borders-as-boxes; hairlines at 8% ink where structure
  is needed.

Canonical values: `shell/web/src/theme/tokens.css` (light + dark). A test keeps the
prototype and the token file in sync.

## Component spec (what Phase 21 builds)

| Component | Notes |
| --- | --- |
| Chat thread | Markdown, streaming text, sparse timestamps; user right-aligned tinted bubble, Lead plain on canvas |
| Composer | Single rounded field, grows to 6 lines, ⏎ send; attach appears only when context allows it |
| Plan card | Title + outcome steps, ticks as phases pass; collapses to one line when done |
| Specialist row | Avatar hue dot, name, status line; states working (shimmer) / done (✓, dimmed) / failed (soft red, Lead explains in thread) |
| Preview card (thread) | Live thumbnail, name + URL pill, expands the rail/sheet |
| Preview pane/sheet | Chrome-less iframe, URL pill, Publish action, mobile grab-handle |
| Approval card | Plain-English summary + primary/secondary actions; resolves to a receipt line |
| Question card | Business question + answer chips + free-text |
| Inline status visuals | Budget bar, run list — rendered *inside* Lead replies |
| Settings sheet | Account / AI connection / Plan & budgets / API tokens / Appearance |
| Command palette | ⌘K, fuzzy, actions + memory search |
| Toast | Bottom-centre, one line, auto-dismiss; only for acknowledgements that need no reply |

Explicitly **absent**: navigation menus, dashboards, run tables, repo/agent CRUD screens,
project switchers, template pickers, model pickers, "advanced settings". Their jobs belong
to the conversation or the palette.

## What the prototype shows

`/design/` (served from the shell, unlinked from the product) is a self-contained clickable
walkthrough: Begin → the team assembling (auto-choreographed, replayable) → preview +
publish flow → conversation-as-OS cards → mobile frames → settings sheet → ⌘K. Desktop and
mobile both. Judged screen-by-screen against the principles above.
