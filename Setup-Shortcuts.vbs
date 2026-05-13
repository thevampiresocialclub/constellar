' Constellar — one-time shortcut installer.
' Double-click this file. It creates a Constellar shortcut on your desktop and
' in your Start menu, then asks if you want it to auto-launch on login.
'
' Re-run any time you want to refresh the shortcuts (e.g. if you moved the
' project folder). Re-running won't duplicate — it overwrites in place.

Option Explicit

Dim fso, shell, scriptDir, launcher, icon, results
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher  = scriptDir & "\Constellar.vbs"
icon      = scriptDir & "\constellar.ico"

If Not fso.FileExists(launcher) Then
    MsgBox "Setup can't find Constellar.vbs in:" & vbCrLf & scriptDir & vbCrLf & vbCrLf & _
           "Run this script from inside the constellar project folder.", 16, "Constellar Setup"
    WScript.Quit 1
End If

If Not fso.FileExists(icon) Then
    icon = ""   ' fall back to default file icon
End If

results = ""

' --- 1. Desktop shortcut ---
Dim desktopPath : desktopPath = shell.SpecialFolders("Desktop")
If MakeShortcut(desktopPath & "\Constellar.lnk", "Open Constellar — your AI-curated feed") Then
    results = results & "  ✓ Desktop shortcut" & vbCrLf
Else
    results = results & "  ✗ Desktop shortcut FAILED" & vbCrLf
End If

' --- 2. Start Menu shortcut ---
Dim startMenuPath : startMenuPath = shell.SpecialFolders("StartMenu") & "\Programs"
If Not fso.FolderExists(startMenuPath) Then fso.CreateFolder startMenuPath
If MakeShortcut(startMenuPath & "\Constellar.lnk", "Open Constellar") Then
    results = results & "  ✓ Start Menu entry" & vbCrLf
Else
    results = results & "  ✗ Start Menu entry FAILED" & vbCrLf
End If

' --- 3. Optional: Startup folder (auto-launch on login) ---
Dim resp : resp = MsgBox("Auto-start Constellar when you log into Windows?" & vbCrLf & vbCrLf & _
                        "Click Yes to add it to your Startup folder. " & _
                        "(You can remove it later via Win+R -> shell:startup.)", _
                        4 + 32, "Constellar Setup")  ' Yes/No + question icon
If resp = 6 Then  ' 6 = Yes
    Dim startupPath : startupPath = shell.SpecialFolders("Startup")
    If MakeShortcut(startupPath & "\Constellar.lnk", "Auto-start Constellar") Then
        results = results & "  ✓ Auto-start on login" & vbCrLf
    Else
        results = results & "  ✗ Auto-start FAILED" & vbCrLf
    End If
Else
    results = results & "  · Auto-start: skipped" & vbCrLf
End If

MsgBox "Done!" & vbCrLf & vbCrLf & results & vbCrLf & _
       "To pin Constellar to your taskbar:" & vbCrLf & _
       "  Right-click the desktop shortcut -> Pin to taskbar" & vbCrLf & vbCrLf & _
       "Or hit the Windows key, type Constellar.", _
       64, "Constellar Setup"   ' info icon

' ---- helper ----
Function MakeShortcut(path, description)
    On Error Resume Next
    Dim sc : Set sc = shell.CreateShortcut(path)
    sc.TargetPath = launcher
    sc.WorkingDirectory = scriptDir
    sc.Description = description
    If icon <> "" Then sc.IconLocation = icon & ",0"
    sc.WindowStyle = 7   ' minimized — though .vbs has no window anyway
    sc.Save
    If Err.Number = 0 Then
        MakeShortcut = True
    Else
        MakeShortcut = False
    End If
    Err.Clear
    On Error Goto 0
End Function
