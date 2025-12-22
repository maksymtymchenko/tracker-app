; Custom NSIS installer script for handling application shutdown during updates
; This script provides graceful shutdown, force close, and retry mechanisms
; Enhanced to handle multi-user scenarios where the app runs in other user sessions
; electron-builder will call this macro before attempting to close the app

!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro customCloseApp
  ; Variables for process detection and shutdown attempts
  Var /GLOBAL ProcessFound
  Var /GLOBAL ShutdownAttempt
  Var /GLOBAL MaxShutdownAttempts
  Var /GLOBAL TotalWaitTime
  Var /GLOBAL CurrentUser
  Var /GLOBAL OtherUserProcesses
  Var /GLOBAL ProcessListFile
  
  ; Initialize variables
  StrCpy $ShutdownAttempt 0
  StrCpy $MaxShutdownAttempts 3
  StrCpy $TotalWaitTime 0
  StrCpy $OtherUserProcesses 0
  
  ; Get current username
  ReadEnvStr $CurrentUser USERNAME
  
  ; Function to detect processes in other user sessions
  ; Uses PowerShell to check for processes owned by other users
  Function DetectOtherUserSessions
    StrCpy $OtherUserProcesses 0
    
    ; Use PowerShell to count processes owned by users other than current user
    GetTempFileName $ProcessListFile
    ExecWait 'powershell -Command "$procs = Get-Process | Where-Object {$_.ProcessName -like ''*Windows*Activity*Tracker*'' -or $_.MainWindowTitle -like ''*Windows Activity Tracker*''}; $currentUser = $env:USERNAME; $otherCount = 0; foreach ($p in $procs) { try { $owner = (Get-CimInstance Win32_Process -Filter \"ProcessId = $($p.Id)\").GetOwner().User; if ($owner -and $owner -ne $currentUser) { $otherCount++ } } catch {} }; Write-Output $otherCount" > "$ProcessListFile"' $R0
    
    ; Read the count from file
    IfFileExists "$ProcessListFile" 0 done
    ClearErrors
    FileOpen $R1 "$ProcessListFile" r
    ${If} ${Errors}
      Goto cleanup_temp
    ${EndIf}
    
    ; Read first line (should contain just the number)
    FileRead $R1 $R2
    FileClose $R1
    
    ; Extract number from the line (remove any whitespace/carriage returns)
    ; Simple approach: find first digit sequence
    StrCpy $R3 ""  ; Result number string
    StrCpy $R4 0   ; Character index
    StrLen $R5 $R2  ; Length of line
    
    parse_loop:
      ${If} $R4 >= $R5
        Goto parse_done
      ${EndIf}
      StrCpy $R6 $R2 1 $R4  ; Get character at index
      ; Check if it's a digit (0-9)
      StrCmp $R6 "0" is_digit
      StrCmp $R6 "1" is_digit
      StrCmp $R6 "2" is_digit
      StrCmp $R6 "3" is_digit
      StrCmp $R6 "4" is_digit
      StrCmp $R6 "5" is_digit
      StrCmp $R6 "6" is_digit
      StrCmp $R6 "7" is_digit
      StrCmp $R6 "8" is_digit
      StrCmp $R6 "9" is_digit
      Goto next_char
      is_digit:
        StrCpy $R3 "$R3$R6"
      next_char:
        IntOp $R4 $R4 + 1
        Goto parse_loop
    
    parse_done:
    ; Convert string to number
    ${If} $R3 != ""
      IntOp $OtherUserProcesses 0 + $R3
    ${EndIf}
    
    cleanup_temp:
    IfFileExists "$ProcessListFile" 0 done
    Delete "$ProcessListFile"
    
    done:
  FunctionEnd
  
  ; Function to check if application is running using multiple methods
  Function CheckAppRunning
    StrCpy $ProcessFound 0
    
    ; Method 1: Check for window (current session only)
    FindWindow $R0 "" "Windows Activity Tracker"
    ${If} $R0 != 0
      StrCpy $ProcessFound 1
      Goto check_done
    ${EndIf}
    
    ; Method 2: Check for process using tasklist (all sessions)
    ; This is more reliable for background processes and detects cross-session processes
    ExecWait 'tasklist /FI "IMAGENAME eq Windows Activity Tracker.exe" /FO CSV | findstr /C:"Windows Activity Tracker.exe"' $R1
    ${If} $R1 == 0
      StrCpy $ProcessFound 1
      Goto check_done
    ${EndIf}
    
    ; Method 3: Alternative process name check (in case of spaces in filename)
    ExecWait 'tasklist /FI "IMAGENAME eq WindowsActivityTracker.exe" /FO CSV | findstr /C:"WindowsActivityTracker.exe"' $R2
    ${If} $R2 == 0
      StrCpy $ProcessFound 1
      Goto check_done
    ${EndIf}
    
    check_done:
  FunctionEnd
  
  ; Function to send graceful shutdown signal
  Function GracefulShutdown
    ; Try to close gracefully by sending WM_CLOSE message
    FindWindow $0 "" "Windows Activity Tracker"
    ${If} $0 != 0
      SendMessage $0 ${WM_CLOSE} 0 0 /TIMEOUT=5000
    ${EndIf}
    
    ; Wait for process to close (check every 500ms for 5 seconds)
    ${For} $R0 1 10
      Sleep 500
      Call CheckAppRunning
      ${If} $ProcessFound == 0
        StrCpy $0 1  ; Success
        Goto graceful_shutdown_done
      ${EndIf}
    ${Next}
    
    StrCpy $0 0  ; Failed
    graceful_shutdown_done:
  FunctionEnd
  
  ; Function to force close application (attempts cross-session termination)
  Function ForceCloseApp
    ; Try multiple process names and force close methods
    ; /F = force, /T = terminate child processes, /FI = filter
    
    ; Method 1: Standard executable name (all sessions)
    ExecWait 'taskkill /F /IM "Windows Activity Tracker.exe" /T' $0
    
    ; Method 2: Alternative name (without spaces)
    ${If} $0 != 0
      ExecWait 'taskkill /F /IM "WindowsActivityTracker.exe" /T' $0
    ${EndIf}
    
    ; Method 3: Kill by window title (if process name doesn't work)
    ${If} $0 != 0
      ExecWait 'taskkill /F /FI "WINDOWTITLE eq Windows Activity Tracker*" /T' $0
    ${EndIf}
    
    ; Wait for process to terminate and verify
    Sleep 2000  ; Give more time for process cleanup
    Call CheckAppRunning
    ${If} $ProcessFound == 0
      StrCpy $0 1  ; Success
    ${Else}
      StrCpy $0 0  ; Failed
    ${EndIf}
  FunctionEnd
  
  ; Main shutdown logic
  Call CheckAppRunning
  ${If} $ProcessFound == 0
    Goto shutdown_success
  ${EndIf}
  
  ; Check for processes in other user sessions
  Call DetectOtherUserSessions
  ${If} $OtherUserProcesses > 0
    ; Found processes in other user sessions - show special dialog
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
      "The application is running in other user sessions.$\n$\n" \
      "Found $OtherUserProcesses instance(s) running under different user accounts.$\n$\n" \
      "To update the application, all instances must be closed.$\n$\n" \
      "Options:$\n" \
      "1. Click 'Yes' to attempt closing all instances (requires Administrator privileges)$\n" \
      "2. Click 'No' to cancel and manually close the application in other sessions$\n$\n" \
      "If you click 'Yes' and it fails, you may need to:$\n" \
      "- Run this installer as Administrator, or$\n" \
      "- Sign out all other user sessions, or$\n" \
      "- Manually close the application in other sessions using Task Manager$\n$\n" \
      "Do you want to attempt closing all instances now?" \
      IDYES try_cross_session \
      IDNO show_multi_user_instructions
    
    try_cross_session:
      ; Attempt to terminate all processes (including other sessions)
      ; This will work if installer is running with admin privileges
      Call ForceCloseApp
      ${If} $0 == 1
        Goto shutdown_success
      ${Else}
        ; Failed to close - show detailed instructions
        Goto show_multi_user_instructions
      ${EndIf}
    
    show_multi_user_instructions:
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "Cannot close application instances in other user sessions.$\n$\n" \
        "The application is running under different user accounts on this computer.$\n$\n" \
        "To proceed with the update, please:$\n$\n" \
        "Option 1 (Recommended):$\n" \
        "1. Close this installer$\n" \
        "2. Right-click this installer and select 'Run as administrator'$\n" \
        "3. Run the installer again$\n$\n" \
        "Option 2:$\n" \
        "1. Sign out all other user sessions$\n" \
        "2. Click Retry to continue$\n$\n" \
        "Option 3:$\n" \
        "1. Open Task Manager (Ctrl+Shift+Esc)$\n" \
        "2. Click 'More details' if needed$\n" \
        "3. Go to 'Users' tab to see all user sessions$\n" \
        "4. For each other user, find 'Windows Activity Tracker' and end the task$\n" \
        "5. Click Retry to continue$\n$\n" \
        "Click Retry after closing all instances, or Cancel to abort installation." \
        IDRETRY retry_check \
        IDCANCEL cancel_install
    
    retry_check:
      Sleep 2000  ; Give user time to close processes
      Call CheckAppRunning
      Call DetectOtherUserSessions
      ${If} $ProcessFound == 0
        Goto shutdown_success
      ${ElseIf} $OtherUserProcesses > 0
        ; Still has other user processes
        Goto show_multi_user_instructions
      ${Else}
        ; Only current user processes remain, continue with normal shutdown
        Goto shutdown_loop
      ${EndIf}
  ${EndIf}
  
  ; Try graceful shutdown with retries (for current session processes)
  shutdown_loop:
    IntOp $ShutdownAttempt $ShutdownAttempt + 1
    
    Call GracefulShutdown
    ${If} $0 == 1
      Goto shutdown_success
    ${EndIf}
    
    ; If graceful shutdown failed and we haven't reached max attempts, try force close
    ${If} $ShutdownAttempt < $MaxShutdownAttempts
      Call ForceCloseApp
      ${If} $0 == 1
        Goto shutdown_success
      ${EndIf}
      ; Wait a bit before retrying
      Sleep 1000
      IntOp $TotalWaitTime $TotalWaitTime + 1000
      Goto shutdown_loop
    ${EndIf}
  
  ; All attempts failed - but if we've waited long enough, assume the app is closed
  ; This handles cases where process detection fails but the app is actually closed
  ${If} $TotalWaitTime >= 10000  ; If we've waited 10+ seconds
    ; Do one final comprehensive check
    Sleep 2000
    Call CheckAppRunning
    Call DetectOtherUserSessions
    ${If} $ProcessFound == 0
      Goto shutdown_success
    ${ElseIf} $OtherUserProcesses > 0
      ; Still has other user processes - show multi-user dialog
      Goto show_multi_user_instructions
    ${EndIf}
  ${EndIf}
  
  ; All attempts failed - show manual close dialog with better instructions
  manual_close_dialog:
    ; Check again for other user sessions
    Call DetectOtherUserSessions
    ${If} $OtherUserProcesses > 0
      Goto show_multi_user_instructions
    ${EndIf}
    
    ; Only current session processes - show standard instructions
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "Unable to close the application, please close it manually.$\n$\n" \
      "Steps to close the application:$\n" \
      "1. Check the system tray (bottom-right corner) for the app icon$\n" \
      "2. Right-click the icon and select 'Quit' or 'Exit'$\n" \
      "3. If no tray icon, open Task Manager (Ctrl+Shift+Esc)$\n" \
      "4. Find 'Windows Activity Tracker' and click 'End Task'$\n$\n" \
      "Click Retry after closing the application." \
      IDRETRY retry_shutdown \
      IDCANCEL cancel_install
  
  retry_shutdown:
    ; Give the user a moment to close the app
    Sleep 1000
    Call CheckAppRunning
    Call DetectOtherUserSessions
    ${If} $ProcessFound == 0
      Goto shutdown_success
    ${ElseIf} $OtherUserProcesses > 0
      Goto show_multi_user_instructions
    ${Else}
      ; Show a simpler retry dialog
      MessageBox MB_RETRYCANCEL|MB_ICONQUESTION \
        "The application is still running. Please make sure it's completely closed and try again." \
        IDRETRY retry_shutdown \
        IDCANCEL cancel_install
    ${EndIf}
  
  cancel_install:
    Abort "Installation cancelled by user"
  
  shutdown_success:
!macroend
