# C3 evidence

This directory contains browser-rendered evidence from the actual Vite/React Thrallo Cloud Desktop.
It is not a static mockup. The screenshots exercise the deterministic filesystem provider only.

The provider exposes virtual workspace paths and records fixture operations. It has no host
filesystem, browser file-picker, shell, Daytona, Builder V2, Supabase, or production-network
capability. C8 may later supply a workspace-gateway provider behind the documented interface.

`screenshots/` covers Files home, nested navigation, grid/details, rename and copy dialogs,
synthetic upload, conflict, Trash, storage warning, a 5,000-entry paginated directory, tablet, and
mobile layouts.
