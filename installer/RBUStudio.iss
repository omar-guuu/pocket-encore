; Inno Setup script for RBU Studio (route A: installs our files only; Node.js, Python, mid2rbu and at3tool are
; installed by the user, and the studio's Setup page checks for them and shows where to get each one).
;
; Build:  install Inno Setup 6 (https://jrsoftware.org/isinfo.php), then
;         "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\RBUStudio.iss
; Output: installer\Output\RBUStudio-Setup-<version>.exe
;
; The installer copies scripts\, studio\, docs\, studio.cmd and README.md; makes Start-menu and desktop shortcuts
; that run studio.cmd; and offers to start the studio at the end. Nothing is installed system-wide and no
; registry keys beyond the uninstaller's are written. Songs are kept in <install dir>\songs (per user: the default
; install dir is %LOCALAPPDATA%\RBUStudio so no admin rights are needed and the tool can write next to itself).

#define MyAppName "RBU Studio"
#define MyAppVersion "0.2"
#define MyAppPublisher "RBU custom songs"
#define MyAppExeName "studio.cmd"

[Setup]
AppId={{7C1E7A5E-5B2D-4C7E-9B21-RBUSTUDIO001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\RBUStudio
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=RBUStudio-Setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
SetupIconFile=..\studio\public\rbu.ico
UninstallDisplayIcon={app}\studio\public\rbu.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\studio.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__"
Source: "..\studio\*"; DestDir: "{app}\studio"; Flags: ignoreversion recursesubdirs; Excludes: ".window"
Source: "..\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs
; songs\ is created empty; existing songs are never touched by an upgrade or an uninstall

[Dirs]
Name: "{app}\songs"
Name: "{app}\out"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\studio\public\rbu.ico"
Name: "{group}\{#MyAppName} guide"; Filename: "{app}\docs\RBU_CUSTOM_SONGS.md"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\studio\public\rbu.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Start {#MyAppName} now"; Flags: postinstall nowait skipifsilent shellexec

[UninstallDelete]
Type: filesandordirs; Name: "{app}\studio\.window"

[Code]
// Node.js is the one piece the studio cannot start without: warn at the end of the install if it is not on PATH.
function NodeFound(): Boolean;
var R: Integer;
begin
  Result := Exec('cmd.exe', '/c where node >nul 2>nul', '', SW_HIDE, ewWaitUntilTerminated, R) and (R = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and (not NodeFound()) then
    MsgBox('Node.js was not found. Install it from https://nodejs.org/en/download (the LTS version), then start RBU Studio.' + #13#10 +
           'The studio''s Setup page lists the other pieces it needs (Python 3.12 with mido/numpy/miniaudio, mid2rbu, at3tool, and your game''s MUSIC folder).',
           mbInformation, MB_OK);
end;
