; Inno Setup script for Pocket Encore (route A: installs our files only; Node.js, Python, mid2rbu and at3tool are
; installed by the user, and the Setup page checks for them and shows where to get each one).
;
; Build:  node scripts\mkinstaller.js        (takes the version from pocketencore\version.json; needs Inno Setup 6,
;                                             https://jrsoftware.org/isinfo.php)
; Output: installer\Output\PocketEncore-Setup-<version>.exe
;
; The installer copies scripts\, pocketencore\, docs\, pocketencore.cmd, README.md, CHANGELOG.md and LICENSE; makes Start-menu and desktop shortcuts
; that run pocketencore.cmd; and offers to start Pocket Encore at the end. Nothing is installed system-wide and no
; registry keys beyond the uninstaller's are written. Songs are kept in <install dir>\songs (per user: the default
; install dir is %LOCALAPPDATA%\PocketEncore so no admin rights are needed and the tool can write next to itself).
;
; Upgrades (a newer installer over an older version): same folder, no questions about where; the program folders are
; emptied first so files a newer version dropped don't linger; songs, settings, out\ and the window profile stay.
; A running Pocket Encore is asked to quit first. Installing an older version over a newer one asks first.
; /UPDATE=1 (used by Pocket Encore's own "Download and install", with /SILENT): no questions, and Pocket Encore starts
; again when done; its open window reconnects and reloads by itself.

#ifndef MyAppVersion
  #error Build with: node scripts\mkinstaller.js (it takes the version from pocketencore\version.json)
#endif
#define MyAppName "Pocket Encore"
#define MyAppPublisher "Pocket Encore"
#define MyAppExeName "pocketencore.cmd"

[Setup]
AppId={{7C1E7A5E-5B2D-4C7E-9B21-0A4D3E6F1B22}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\PocketEncore
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=PocketEncore-Setup-{#MyAppVersionFile}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
SetupIconFile=..\pocketencore\public\rbu.ico
UninstallDisplayIcon={app}\pocketencore\public\rbu.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; the program's own folders and files, so an upgrade leaves no files a newer version dropped. Never songs\, out\,
; settings.json, cache\ or pocketencore\.window (the window's saved theme and controller layout).
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\docs"
Type: filesandordirs; Name: "{app}\pocketencore\public"
Type: files; Name: "{app}\pocketencore\*.js"
Type: files; Name: "{app}\pocketencore\version.json"

[Files]
Source: "..\pocketencore.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "..\CHANGELOG.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__"
Source: "..\pocketencore\*"; DestDir: "{app}\pocketencore"; Flags: ignoreversion recursesubdirs; Excludes: ".window,.running"
Source: "..\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs
; songs\ is created empty; existing songs are never touched by an upgrade or an uninstall

[Dirs]
Name: "{app}\songs"
Name: "{app}\out"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\pocketencore\public\rbu.ico"
Name: "{group}\{#MyAppName} guide"; Filename: "{app}\docs\RBU_CUSTOM_SONGS.md"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\pocketencore\public\rbu.ico"; Tasks: desktopicon

[Run]
; --reconnect: a window that was already open (before an upgrade) reconnects instead of a second one opening
Filename: "{app}\{#MyAppExeName}"; Parameters: "--reconnect {code:PortArg}"; Description: "Start {#MyAppName} now"; Flags: postinstall nowait skipifsilent shellexec
Filename: "{app}\{#MyAppExeName}"; Parameters: "--reconnect {code:PortArg}"; Flags: nowait shellexec; Check: IsUpdate

[UninstallDelete]
Type: filesandordirs; Name: "{app}\pocketencore\.window"
Type: files; Name: "{app}\pocketencore\.running"

[Code]
var
  RunningPort: String;  // the port a running Pocket Encore used: it starts again on the same one

const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7C1E7A5E-5B2D-4C7E-9B21-0A4D3E6F1B22}_is1';

// /UPDATE=1: started by Pocket Encore's "Download and install"
function IsUpdate(): Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

// "0.4.1 Beta" -> 4001, "1.12" -> 1012000 (major * 1000000 + minor * 1000 + patch)
function VerNum(S: String): Integer;
var P, I, N: Integer;
begin
  S := Trim(S);
  P := Pos(' ', S); if P > 0 then S := Copy(S, 1, P - 1);
  Result := 0;
  for I := 1 to 3 do begin
    P := Pos('.', S);
    if P = 0 then begin N := StrToIntDef(S, 0); S := ''; end
    else begin N := StrToIntDef(Copy(S, 1, P - 1), 0); S := Copy(S, P + 1, Length(S)); end;
    Result := Result * 1000 + N;
  end;
end;

// installing an older version over a newer one: ask first
function InitializeSetup(): Boolean;
var Prev: String;
begin
  Result := True;
  if RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', Prev) and (VerNum(Prev) > VerNum('{#MyAppVersion}')) then
    // (SuppressibleMsgBox: a silent install takes the default answer, here No, instead of waiting)
    Result := SuppressibleMsgBox('Pocket Encore ' + Prev + ' is installed, which is newer than this installer ({#MyAppVersion}).' + #13#10 +
                     'Install the older version anyway?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES;
end;

function RunPowerShell(Cmd: String): Integer;
var R: Integer;
begin
  if Exec('powershell.exe', '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Cmd + '"', '', SW_HIDE, ewWaitUntilTerminated, R) then Result := R
  else Result := -1;
end;

// a number from Pocket Encore's "running" note: {"pid":1234,"port":8642}
function NoteNumber(S: String; Key: String): String;
var P, I: Integer;
begin
  Result := '';
  P := Pos('"' + Key + '":', S);
  if P = 0 then exit;
  for I := P + Length(Key) + 3 to Length(S) do
    if (S[I] >= '0') and (S[I] <= '9') then Result := Result + S[I]
    else if Result <> '' then break;
end;

// a Pocket Encore running from this folder: its process id and port, from the "running" note its server keeps
function RunningCopy(var Pid, Port: String): Boolean;
var Note: AnsiString;
begin
  Result := False;
  if not LoadStringFromFile(ExpandConstant('{app}\pocketencore\.running'), Note) then exit;
  Pid := NoteNumber(Note, 'pid'); Port := NoteNumber(Note, 'port');
  if (Pid = '') or (Port = '') then exit;
  // still running, and really Pocket Encore's server?
  Result := RunPowerShell('$p = Get-CimInstance Win32_Process -Filter ''ProcessId=' + Pid + '''; if ($p -and $p.CommandLine -like ''*server.js*'') { exit 0 } else { exit 1 }') = 0;
end;

// ask it to quit (a clean exit closes its console window); if it doesn't within 8 s, stop it
procedure QuitCopy(Pid, Port: String);
begin
  RunPowerShell('try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:' + Port + '/api/quit -TimeoutSec 3 | Out-Null } catch {}; ' +
                'Wait-Process -Id ' + Pid + ' -Timeout 8 -ErrorAction SilentlyContinue; ' +
                'if (Get-Process -Id ' + Pid + ' -ErrorAction SilentlyContinue) { Stop-Process -Id ' + Pid + ' -Force }');
end;

// a running Pocket Encore (from this folder) quits before its files are replaced
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Pid, Port: String;
begin
  Result := '';
  if not RunningCopy(Pid, Port) then exit;
  RunningPort := Port;
  if (not IsUpdate()) and (SuppressibleMsgBox('Pocket Encore is running. Close it and continue?' + #13#10 + 'Unsaved changes in Pocket Encore are lost.', mbConfirmation, MB_YESNO, IDYES) <> IDYES) then begin
    Result := 'Pocket Encore is still running. Close it, then run the installer again.';
    exit;
  end;
  QuitCopy(Pid, Port);
end;

// the port to start on again: /PORT= from Pocket Encore's update, else the one a running copy used (8642 = default)
function PortArg(Param: String): String;
var P: String;
begin
  P := ExpandConstant('{param:PORT|}');
  if P = '' then P := RunningPort;
  if (P <> '') and (P <> '8642') then Result := '--port ' + P else Result := '';
end;

// Node.js is the one piece Pocket Encore cannot start without: warn at the end of the install if it is not on PATH.
function NodeFound(): Boolean;
var R: Integer;
begin
  Result := Exec('cmd.exe', '/c where node >nul 2>nul', '', SW_HIDE, ewWaitUntilTerminated, R) and (R = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and (not NodeFound()) then
    SuppressibleMsgBox('Node.js was not found. Install it from https://nodejs.org/en/download (the LTS version), then start Pocket Encore.' + #13#10 +
           'Pocket Encore''s Setup page lists the other pieces it needs (Python 3.12 with mido/numpy/miniaudio, mid2rbu, at3tool, and your game''s MUSIC folder).',
           mbInformation, MB_OK, IDOK);
end;

// ---------- uninstall ----------
var
  DeleteUserData: Boolean;

// once the removal is confirmed: a running Pocket Encore quits, and its window closes (it uses the window profile the
// uninstall removes)
procedure CloseRunningCopy();
var Pid, Port, Dir: String;
begin
  if RunningCopy(Pid, Port) then QuitCopy(Pid, Port);
  // its window: the Edge/Chrome processes that use this folder's window profile (and only those)
  Dir := ExpandConstant('{app}\pocketencore\.window');
  StringChangeEx(Dir, '''', '''''', True);
  RunPowerShell('Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq ''msedge.exe'' -or $_.Name -eq ''chrome.exe'') -and $_.CommandLine -and $_.CommandLine.Contains(''' + Dir + ''') } | ' +
                'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $_.ProcessId -Timeout 5 -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800');
end;

// what Pocket Encore itself creates next to the program: songs (with stems and edited charts), built output, settings
function HasUserData(): Boolean;
var App: String;
begin
  App := ExpandConstant('{app}');
  Result := DirExists(App + '\songs') or DirExists(App + '\out') or DirExists(App + '\reaper') or DirExists(App + '\incoming') or
            DirExists(App + '\cache') or FileExists(App + '\settings.json');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var App, Msg: String; ResultCode: Integer;
begin
  App := ExpandConstant('{app}');
  if CurUninstallStep = usUninstall then begin
    CloseRunningCopy();
    // a silent uninstall keeps them (the default answer, No)
    DeleteUserData :=HasUserData() and (SuppressibleMsgBox('Also delete your songs, settings and built output?' + #13#10 + #13#10 +
      'They are in ' + App + ' (songs, out, settings.json). If you keep them, installing Pocket Encore again in the same folder finds them.',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES);
  end;
  if CurUninstallStep = usPostUninstall then begin
    if DeleteUserData then begin
      DelTree(App + '\songs', True, True, True);
      DelTree(App + '\out', True, True, True);
      DelTree(App + '\reaper', True, True, True);
      DelTree(App + '\incoming', True, True, True);
      DelTree(App + '\cache', True, True, True);
      DeleteFile(App + '\settings.json');
    end;
    // the window profile once more: a closing browser can still write a few files into it after [UninstallDelete]
    DelTree(App + '\pocketencore\.window', True, True, True);
    // paths over 260 characters (an install folder deep in other folders): rd with the \\?\ prefix handles them
    if DirExists(App + '\pocketencore\.window') then Exec(ExpandConstant('{cmd}'), '/c rd /s /q "\\?\' + App + '\pocketencore\.window"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    RemoveDir(App + '\pocketencore');
    RemoveDir(App);  // only when nothing is left in it
    Msg := 'Pocket Encore was removed.';
    if HasUserData() then Msg := Msg + #13#10 + #13#10 + 'Your songs, settings and built output are still in ' + App + '. Delete that folder to remove them too.'
    else if DirExists(App) then Msg := Msg + #13#10 + #13#10 + App + ' still holds files you put there yourself (for example at3tool or mid2rbu).';
    Msg := Msg + #13#10 + #13#10 + 'Custom songs you copied to PPSSPP''s memory stick stay there: to remove them, delete their folders and ZZCUSTOMDB from PSP\GAME\ULUS10418\MUSIC.';
    SuppressibleMsgBox(Msg, mbInformation, MB_OK, IDOK);
  end;
end;
