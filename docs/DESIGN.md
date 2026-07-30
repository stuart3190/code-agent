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
A calm, almost-empty page. A greeting in display type, one question — **"What are we
building today?"** — one beautiful input, and up to three memory-grounded chips ("Continue
FocusFlow", "Something new"). No dashboard, no project list, no cards. Memory (Principle 8)
is why chips can be this personal; the command palette (⌘K) is where old
conversations/products are searched — never a permanent list.

**Greeting composition (never scripted-feeling, per Stuart's wireframe review):** the
greeting is *generated from memory*, not templated small talk. Default: "Welcome back,
Stuart." With active product context it becomes aware: "Welcome back — Thrallo is ready to
continue your Competition Site." A chip for the active product carries a live dot when its
preview is still up. First-ever visit: "Let's build something." The greeting is the Lead
Agent speaking, so it obeys the Voice rules below.

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
rail glides into preview state. **The preview dominates (Stuart's wireframe review): it is
the product, so on arrival it takes the room** — the rail expands to roughly half the
viewport (56vw, capped), the conversation yields to a comfortable reading column beside it,
and a one-time accent glow pulls the eye to it as the culmination of the team's work. The
pane carries the natural next step — **Publish** — as an in-card action (approval surfaces,
Platform Architecture 7), never a "Continue?". Publishing resolves the card into a receipt
line ("Live at focusflow.thrallo.app ↗") that stays in history. Anticipation (Principle 9):
the Lead Agent offers the obvious next step ("Want a proper domain?") without being asked.

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

## Voice — the Lead Agent sounds like a senior engineer you've worked with for years

Added at Stuart's wireframe review; this is a hard rule for every string the Lead Agent
produces (greeting included) and for Phase 21 copy reviews.

- **First person, plain English, warm but not chatty.** "I've got the first version ready —
  take a look." Never mechanical relay: "Publisher completed preview" is banned phrasing.
- **Proactive observations are the magic (Principle 9).** The Lead Agent notices and acts
  before being asked, and says so naturally: "The break screen felt a bit flat next to the
  focus view, so I'm having it polished before you see it."
- **Owns the team's work as "I/we", credits specialists only when it aids understanding.**
  The user manages one relationship (Principle 11); the roster is ambient, not narrated.
- **Ends with the obvious next step when there is one** ("Say the word and I'll publish
  it") — an offer, never a gate.
- Specialist *status lines* stay short and human ("Polishing the break screen…") — they are
  captions on the roster, not sentences in the thread.

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
- **Animation exists to communicate state, not decorate it** (Stuart, Phase 21 approval —
  a hard implementation rule): every transition must direct attention, explain progress, or
  reinforce continuity. Any animation that exists only because it looks impressive is
  removed in review.
- **The user should never wonder whether Thrallo is working** (Stuart, Phase 22 approval —
  a hard implementation rule): every long-running action communicates meaningful progress
  through the Lead Agent, the specialist team, or a visible state transition. Silence must
  never be mistakable for inactivity — a capability that can take more than a moment MUST
  emit specialist status updates while it runs.
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
