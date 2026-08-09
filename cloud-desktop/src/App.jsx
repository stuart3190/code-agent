import { PROTOTYPE_TITLE } from "./config/prototype.js";
import { createFixtureProvider } from "./providers/fixtureProvider.js";

const provider = createFixtureProvider({ seed: "thrallo-cloud-desktop-c0", scenario: "neutral" });

export default function App() {
  const bootstrap = provider.getBootstrapState();

  return (
    <main className="prototype" data-provider-kind={bootstrap.providerKind}>
      <h1>{PROTOTYPE_TITLE}</h1>
    </main>
  );
}
