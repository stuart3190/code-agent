// TWO CONTROLS THAT HOLD THE SAME KIND OF VALUE, ON ONE SCREEN.
//
// The integrity question for opaque identity: shipping.address beside billing.address,
// checkout.email beside account.email, notes on two different forms. An identity derived from a
// bare field name is the same identity twice — so either the app distinguishes them, or the
// platform must say it cannot tell them apart. Silently driving the first one is the positional
// guessing this whole architecture exists to remove.
//
//   window.__SCOPED__ = false  two `notes` controls with no scope → one identity, twice
//   window.__SCOPED__ = true   the same two controls scoped → two identities

const FLOW = `import { useState } from "react";
import { useSemanticField } from "../lib/capabilities/react.js";

const SCOPED = typeof window !== "undefined" && window.__SCOPED__ === true;

export function Flow() {
  const [intake, setIntake] = useState("");
  const [review, setReview] = useState("");
  // Same logical field, two places on one screen — the shape of shipping/billing address.
  const intakeNotes = useSemanticField({ name: "notes", scope: SCOPED ? "intake" : null,
    label: "Intake notes", value: intake, onChange: setIntake });
  const reviewNotes = useSemanticField({ name: "notes", scope: SCOPED ? "review" : null,
    label: "Review notes", value: review, onChange: setReview });

  return <main>
    <h1>Case desk</h1>
    <p>The case desk headline and both note forms are shown.</p>
    <section>
      <h2>Intake</h2>
      <label {...intakeNotes.labelProps} /><input {...intakeNotes.inputProps} />
    </section>
    <section>
      <h2>Review</h2>
      <label {...reviewNotes.labelProps} /><input {...reviewNotes.inputProps} />
    </section>
    {intake || review ? <p>The entered notes remain visible: {intake} · {review}</p> : null}
  </main>;
}
`;

const APP = `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }
`;

export function scopedIdentityApp() {
  return { "src/components/Flow.jsx": FLOW, "src/App.jsx": APP };
}

/** One contracted `notes` control. The app renders two; that is the ambiguity under test. */
export const SCOPED_CONTRACT = {
  summary: "Case desk scoped identity", projectType: "web app", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Cases" }],
  entities: [{ name: "case", fields: [{ name: "notes", type: "string" }] }],
  operations: [],
  journeys: [{ id: "notes", title: "An operator records notes", priority: "primary", steps: [
    { action: "open the case desk", target: "/", expect: "the case desk headline and both note forms are shown" },
    { action: "enter the notes", target: "notes form", expect: "the entered notes remain visible" },
  ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};
