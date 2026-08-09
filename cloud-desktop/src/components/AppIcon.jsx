import {
  Browser as BrowserIcon,
  Cloud,
  CubeTransparent,
  FolderSimple,
  GithubLogo,
  GearSix,
  HardDrives,
  TerminalWindow,
} from "@phosphor-icons/react";

const icons = {
  thrallo: CubeTransparent,
  browser: BrowserIcon,
  files: FolderSimple,
  terminal: TerminalWindow,
  github: GithubLogo,
  storage: HardDrives,
  settings: GearSix,
  cloud: Cloud,
};

export function AppIcon({ name, size = 24, weight = "duotone", ...props }) {
  const Icon = icons[name] ?? CubeTransparent;
  return <Icon aria-hidden="true" size={size} weight={weight} {...props} />;
}
