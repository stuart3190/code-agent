// The first-run experience.
//
// Six short steps, skippable from every one of them, and it ends by actually starting something
// rather than by saying "you're all set". Progress is stored server-side, so closing the tab
// resumes where it was and a second device does not start again.
//
// What this deliberately is NOT: a fake project, a simulated build, or a progress bar that fills
// itself. Every screen describes what really happens, and the last one hands over to the real
// starter gallery — the same one the dashboard offers — so the first build is a real build.

import React, { useEffect, useRef, useState } from "react";
import StarterGallery from "./StarterGallery.jsx";

const STEPS = [
  {
    id: "welcome",
    title: "Welcome to Thrallo",
    body:
      "Thrallo is a team of AI engineers you talk to. You describe what you want in plain English, "
      + "they plan it, build it, and put it online. There is nothing to install and no code to write "
      + "unless you want to.",
    aside: "This takes about a minute. You can skip it at any point.",
  },
  {
    id: "describe",
    title: "Describe what you want",
    body:
      "Write it the way you would explain it to a colleague. Who is it for, what should it do, and "
      + "what matters most. Detail helps — \"a booking system for a physio clinic where two "
      + "practitioners share a calendar\" gets you much further than \"a booking app\".",
    aside: "If a blank page is hard, the idea gallery at the end gives you a strong first draft.",
  },
  {
    id: "plan",
    title: "You see the plan before anything is built",
    body:
      "The team writes a short plan first — what it will build and in what order. You can read it, "
      + "argue with it, or just say go. Nothing is built until the plan makes sense to you.",
    aside: "Changed your mind halfway? Say so. The plan is a conversation, not a contract.",
  },
  {
    id: "iterate",
    title: "Change anything by asking",
    body:
      "When the first version arrives, tell the team what to change: \"make the dashboard the "
      + "landing page\", \"the booking form is asking too much\". Each change is a normal message. "
      + "Your earlier versions are kept, so nothing is lost by trying something.",
    aside: "There is no separate edit mode. It is the same conversation throughout.",
  },
  {
    id: "publish",
    title: "Preview, publish, and take it with you",
    body:
      "A live preview appears as soon as there is something to see. When you are happy, publishing "
      + "puts it on a real web address in seconds — and you can connect your own domain. You can "
      + "export the whole project as code whenever you like; it is yours.",
    aside: "Publishing is reversible. You can roll back to any earlier deployment.",
  },
  {
    id: "start",
    title: "Let's build something",
    body:
      "Pick an idea to start from, or close this and describe your own. Either way the next thing "
      + "that happens is a real build on your account.",
    aside: null,
  },
];

export default function Onboarding({ initialStep = 0, onStep, onSkip, onComplete, onUseStarter }) {
  const [index, setIndex] = useState(Math.min(Math.max(initialStep, 0), STEPS.length - 1));
  const heading = useRef(null);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  // Focus the heading on every step so a screen reader announces the new screen rather than
  // leaving the caret on a button whose label has just changed underneath it.
  useEffect(() => { heading.current?.focus(); }, [index]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); onSkip(index); }
      if (event.key === "ArrowRight" && !last) next();
      if (event.key === "ArrowLeft" && index > 0) back();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const next = () => {
    const to = Math.min(index + 1, STEPS.length - 1);
    setIndex(to);
    onStep?.(to);
  };
  const back = () => {
    const to = Math.max(index - 1, 0);
    setIndex(to);
    onStep?.(to);
  };

  return (
    <>
      <div className="ct-scrim show" aria-hidden="true" />
      <div className="st-onboard" role="dialog" aria-modal="true" aria-labelledby="st-onboard-title">
        <div className="st-onboard-top">
          {/* Position, not a fake progress bar: it says where you are, and it is honest that the
              tour is six screens rather than implying work is being done. */}
          <div className="st-onboard-dots" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              <span key={s.id} className={`st-onboard-dot ${i === index ? "on" : ""} ${i < index ? "done" : ""}`} />
            ))}
          </div>
          <button className="ct-btn-quiet" onClick={() => onSkip(index)}>Skip and start building</button>
        </div>

        <div className="st-onboard-body">
          <h2 id="st-onboard-title" ref={heading} tabIndex={-1}>{step.title}</h2>
          <p>{step.body}</p>
          {step.aside && <p className="ct-hint">{step.aside}</p>}

          {last && (
            <div className="st-onboard-gallery">
              <StarterGallery compact onUse={(prompt, starterId) => onUseStarter(prompt, starterId)} />
            </div>
          )}
        </div>

        <div className="st-onboard-actions">
          <button className="ct-btn-quiet" disabled={index === 0} onClick={back}>Back</button>
          {last
            ? <button className="ct-btn" onClick={() => onComplete(index)}>Close and write my own</button>
            : <button className="ct-btn" onClick={next}>Next</button>}
        </div>
      </div>
    </>
  );
}

export const ONBOARDING_STEPS = STEPS.length;
