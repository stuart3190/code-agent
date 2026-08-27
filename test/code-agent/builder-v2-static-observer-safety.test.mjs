import test from "node:test";
import assert from "node:assert/strict";

import {
  lintSelfTriggeringMutationObservers,
} from "../../shell/server/lib/builderV2/staticApplicationGate.mjs";

test("a catalogue observer cannot unconditionally rewrite its watched attribute", () => {
  const tree = {
    "src/screens/CatalogueScreen.jsx": `
      import { useEffect } from "react";
      export default function CatalogueScreen() {
        useEffect(() => {
          const root = document.querySelector("[data-catalogue]");
          const exposeItems = () => {
            root.querySelectorAll("[data-item]").forEach((item) => {
              item.setAttribute("data-catalogue-state", "ready");
            });
          };
          const observer = new MutationObserver(exposeItems);
          observer.observe(root, {
            attributes: true,
            subtree: true,
            attributeFilter: ["data-catalogue-state"],
          });
          return () => observer.disconnect();
        }, []);
        return <main data-catalogue />;
      }
    `,
  };

  const findings = lintSelfTriggeringMutationObservers(tree);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "self_triggering_mutation_observer");
  assert.equal(findings[0].attribute, "data-catalogue-state");
});

test("an idempotent catalogue observer may guard the watched attribute before writing", () => {
  const tree = {
    "src/screens/CatalogueScreen.jsx": `
      export function observeCatalogue(root) {
        const refreshItems = () => {
          root.querySelectorAll("[data-item]").forEach((item) => {
            if (item.getAttribute("data-catalogue-state") !== "ready") {
              item.setAttribute("data-catalogue-state", "ready");
            }
          });
        };
        const observer = new MutationObserver(refreshItems);
        observer.observe(root, {
          attributes: true,
          subtree: true,
          attributeFilter: ["data-catalogue-state"],
        });
        return () => observer.disconnect();
      }
    `,
  };

  assert.deepEqual(lintSelfTriggeringMutationObservers(tree), []);
});
