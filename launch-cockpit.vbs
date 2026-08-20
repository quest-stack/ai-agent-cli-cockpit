' CLI Cockpit launcher (silent, no console window).
' ASCII only. Calls electron.exe directly so no cmd/console window appears.
Option Explicit

Dim fso, sh, root, electronExe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = fso.BuildPath(root, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(electronExe) Then
    MsgBox "electron.exe not found. Run 'npm install' first.", vbCritical, "CLI Cockpit"
    WScript.Quit 1
End If

sh.CurrentDirectory = root

' Run electron.exe with "." (the app dir). Hidden window flag is irrelevant for a
' GUI exe, but there is no console window since we bypass cmd/node wrappers.
cmd = Chr(34) & electronExe & Chr(34) & " ."
sh.Run cmd, 1, False
