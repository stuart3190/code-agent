# The starter gallery

Ten expert opening prompts, in `shell/shared/starters.mjs`. They are **prompts, not templates** —
Principle 7. Choosing one puts editable text in the composer and sends it down the ordinary
Plan → Build path; there is no template engine, no scaffold branch and no second pipeline.
`routes/templates.mjs` exists as retired Buildr101 code and stays unmounted.

## What makes a prompt here "expert"

Every one of them does four things, and `test/code-agent/first-run.test.mjs` enforces all four:

1. **Names the audience and the job.** "A CRM" produces a generic CRM; "a CRM for a two-person
   recruitment agency tracking candidates through stages" produces something usable.
2. **States the entities and the primary screens**, so the planner does not guess the data model —
   the biggest single cause of a first build that misses.
3. **Says what NOT to build.** Left unsaid, a first build sprawls into settings pages and admin
   panels nobody asked for.
4. **Ends with the first thing to get right**, so there is an obvious next sentence to send.

## Validated by real builds

`ops/prove-starters-build.mjs` sends each prompt through `postUserMessage` — the same call the
composer makes — and waits for the conversation to reach a terminal state. It spends real tokens,
so it is deliberately **not** part of the routine proof suite.

Run 2026-08-04, against deployed production, managed lane (`gpt-5.6-sol`), **54/54 checks passed**:

| Starter | Outcome | Time | Produced |
|---|---|---|---|
| `landing` | idle | 21s | plan, build |
| `dashboard` | idle | 21s | plan, build |
| `ecommerce` | idle | 21s | plan, build |
| `saas` | idle | 31s | plan, build |
| `crm` | idle | 31s | plan, build |
| `booking` | idle | 31s | plan, build |
| `portfolio` | idle | 32s | plan, build |
| `docs` | idle | 34s | plan, build |
| `ai-chat` | idle | 37s | plan, build |
| `blog` | idle | 45s | plan, build |

Every one planned and dispatched a build, and every one recorded its prompt and its model — which
is what History then shows.

Each starter runs on its own throwaway account, deleted afterwards. That is not tidiness: the owner
accounts carry BYOK credentials, so a build there exercises whichever provider that account has
selected rather than the managed lane a new customer actually lands on.

## What the first run found

The first attempt ran on the `support@thrallo.com` owner account and failed in 11 seconds with
`xai_key_rejected` — that account is routed to xAI and **its xAI key is out of credits**. Two
things came out of it:

- The prompt was not at fault, and a proof that had used an owner account would have reported a
  perfectly good starter as broken.
- The failure path behaved correctly: an incident was captured, a plain-language message was
  returned, and the conversation reached a terminal state in 11 seconds rather than hanging. That
  is Phase 7's stall and recovery work doing its job on a real provider outage.

**This is an operational item for Stuart, not a product defect.** Ordinary customers use the managed
Anthropic/OpenAI lane, which is configured and working. Only the support account is affected, and
only because it has a BYOK xAI key selected.

## Changing a starter

Edit `shell/shared/starters.mjs`, then re-run that category and update the table above:

```
node ops/prove-starters-build.mjs crm
```

The prompt copy is covered by tests that check for the four properties, not for exact wording, so
rewording is free and dropping "Do not build …" is not.
