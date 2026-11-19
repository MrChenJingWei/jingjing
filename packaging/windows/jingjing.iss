; 静静 Windows 安装包（Inno Setup 6.5+）。由 packaging/windows/build.ps1 调用：
;   ISCC.exe /DAppVersion=0.11.0 /DAppFiles=<build\Jingjing> /DOutputDir=<dist> /DIconFile=<build\app.ico> jingjing.iss
; 按当前用户安装到 %LOCALAPPDATA%\Programs\Jingjing，不需要管理员权限。
; 数据（%LOCALAPPDATA%\Jingjing）卸载时保留，和 macOS App 一样。

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppFiles
  #define AppFiles "build\Jingjing"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif
#ifndef IconFile
  #define IconFile "build\app.ico"
#endif

[Setup]
AppId={{97F868ED-0D19-429D-ACBE-E50CAB782098}
AppName=静静
AppVersion={#AppVersion}
AppVerName=静静 {#AppVersion}
AppPublisher=静静
AppPublisherURL=https://github.com/MrChenJingWei/jingjing
AppSupportURL=https://github.com/MrChenJingWei/jingjing/issues
VersionInfoVersion={#AppVersion}
VersionInfoProductName=静静
VersionInfoDescription=静静安装程序
DefaultDirName={autopf}\Jingjing
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17134
OutputDir={#OutputDir}
OutputBaseFilename=jingjing-{#AppVersion}-windows-x64-setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Jingjing.exe
UninstallDisplayName=静静
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no
; 正在运行的静静由下面的 [Code] 用 Jingjing.exe --quit 正常关掉，不用 Restart Manager 去强关。
CloseApplications=no

[Languages]
Name: "zh"; MessagesFile: "Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "在桌面创建快捷方式"; Flags: unchecked
Name: "autostart"; Description: "登录 Windows 时自动在后台启动静静"; Flags: unchecked

[InstallDelete]
; 覆盖安装时先清掉旧版本的服务代码，免得新版本删掉的文件还留着。
Type: filesandordirs; Name: "{app}\app"

[Files]
Source: "{#AppFiles}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\静静"; Filename: "{app}\Jingjing.exe"
Name: "{autodesktop}\静静"; Filename: "{app}\Jingjing.exe"; Tasks: desktopicon

[Registry]
; 和 App 托盘菜单里的「开机时启动」是同一个开机项。
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "JingjingDesktop"; ValueData: """{app}\Jingjing.exe"" --background"; Tasks: autostart

[Run]
Filename: "{app}\Jingjing.exe"; Description: "启动静静"; Flags: nowait postinstall skipifsilent

[Code]
// 让正在运行的静静先正常退出（停好服务、记好任务断点），再覆盖或删除文件。
procedure QuitRunningApp();
var
  ResultCode: Integer;
  Exe: String;
begin
  Exe := ExpandConstant('{app}\Jingjing.exe');
  if FileExists(Exe) then
    Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  QuitRunningApp();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  QuitRunningApp();
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  // App 自己在托盘菜单里打开的开机项，卸载时一起删掉。数据目录保留。
  if CurUninstallStep = usPostUninstall then
    RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'JingjingDesktop');
end;
