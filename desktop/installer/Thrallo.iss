; Thrallo Desktop — Windows x64 installer (Inno Setup 6).
; User-level install (no admin prompt), Start menu shortcut, optional desktop shortcut,
; standard uninstall. Signed-ready: uncomment SignTool below once a code-signing
; certificate is configured in the Inno Setup IDE / ISCC command line.
;
; Build:  ISCC.exe desktop\installer\Thrallo.iss
; Input:  desktop\VSCode-win32-x64  (produced by: node desktop/build.mjs package)
; Output: desktop\out\Thrallo-Setup-x64.exe

#define MyAppName "Thrallo"
#define MyAppVersion "1.131.0"
#define MyAppPublisher "Thrallo"
#define MyAppURL "https://app.thrallo.com"
#define MyAppExeName "Thrallo.exe"

[Setup]
AppId={{6F8E2D41-9C3B-4A57-8D12-4B7E5C9A0F31}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\out
OutputBaseFilename=Thrallo-Setup-x64
SetupIconFile=..\assets\thrallo.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
; SignTool=signtool  ; enable once a certificate is configured

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\VSCode-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
