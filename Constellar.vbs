' Constellar — silent tray launcher.
' Run this and a star icon appears in the system tray.
' Double-clicking when already running just opens the browser.
'
' On failure, an error log is written to %TEMP%\constellar-launch.log so
' silent breakage isn't truly silent.

Option Explicit

Dim fso, scriptDir, shell, logPath
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptDir
logPath = shell.ExpandEnvironmentStrings("%TEMP%\constellar-launch.log")

Sub LogLine(msg)
    Dim ts, f
    ts = Now & " | "
    On Error Resume Next
    Set f = fso.OpenTextFile(logPath, 8, True)
    If Not f Is Nothing Then
        f.WriteLine ts & msg
        f.Close
    End If
    On Error Goto 0
End Sub

' Is the server already running? Use netstat for a definitive answer
' (MSXML2 sometimes caches dead connections in TIME_WAIT and lies).
' We only consider it running if there's an actual LISTENING socket on 5173.
Dim alreadyRunning : alreadyRunning = False
Dim exec, line
On Error Resume Next
Set exec = shell.Exec("cmd /c netstat -ano -p TCP")
If Err.Number = 0 Then
    Do While Not exec.StdOut.AtEndOfStream
        line = exec.StdOut.ReadLine
        If InStr(line, ":5173 ") > 0 And InStr(line, "LISTENING") > 0 Then
            alreadyRunning = True
            Exit Do
        End If
    Loop
End If
Err.Clear
On Error Goto 0

If alreadyRunning Then
    LogLine "server already listening on 5173, opening browser"
    shell.Run "http://127.0.0.1:5173", 1, False
    WScript.Quit 0
End If

' Try the Python launcher first (windowed = no console).
' Fall back to bare pythonw.exe if pyw isn't on PATH.
Dim cmd : cmd = ""
Dim candidates : candidates = Array("pyw -u app.py --tray", _
                                    "pythonw -u app.py --tray", _
                                    "python -u app.py --tray")

Dim c
For Each c In candidates
    On Error Resume Next
    ' shell.Run with style=0 hides the window. Returns immediately because
    ' we don't wait. Errors here would only surface for invalid syntax,
    ' not for missing executables — those silently no-op. So we test by
    ' running with cmd /c and capturing the exit code briefly.
    Dim testCmd : testCmd = "cmd /c " & Split(c, " ")(0) & " --version >nul 2>&1"
    Dim rc : rc = shell.Run(testCmd, 0, True)
    If Err.Number = 0 And rc = 0 Then
        cmd = c
        Exit For
    End If
    Err.Clear
    On Error Goto 0
Next

If cmd = "" Then
    LogLine "ERROR: no Python launcher found (tried pyw, pythonw, python)"
    MsgBox "Constellar can't find Python. Install Python 3.10+ from python.org.", 16, "Constellar"
    WScript.Quit 1
End If

LogLine "launching: " & cmd
shell.Run cmd, 0, False
