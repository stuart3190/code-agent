import { Cube, FolderOpen, RocketLaunch } from "@phosphor-icons/react";
import { AppIcon } from "../components/AppIcon.jsx";

export function ThralloApp() {
  return (
    <div className="app-view thrallo-placeholder" data-testid="thrallo-placeholder">
      <div className="thrallo-mark"><AppIcon name="thrallo" size={46} weight="fill" /></div>
      <span className="eyebrow">Thrallo</span>
      <h1>Your AI software-building workspace will live here.</h1>
      <p>Thrallo integration will be connected later.</p>
      <div className="placeholder-capabilities" aria-label="Future Thrallo capabilities">
        <div><Cube weight="duotone" /><span><strong>Build applications</strong><small>Create and shape products with AI.</small></span></div>
        <div><FolderOpen weight="duotone" /><span><strong>Manage projects</strong><small>Keep your work organised in one place.</small></span></div>
        <div><RocketLaunch weight="duotone" /><span><strong>Preview and publish</strong><small>Bring ideas to life when integration arrives.</small></span></div>
      </div>
      <div className="fixture-note">Placeholder application · no Builder V2 connection</div>
    </div>
  );
}
