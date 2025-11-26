; Custom NSIS installer script for handling application shutdown during updates
; This script provides graceful shutdown, force close, and retry mechanisms
; electron-builder will call this macro before attempting to close the app

!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro customCloseApp
  ; Variables for process detection and shutdown attempts
  Var /GLOBAL ProcessFound
  Var /GLOBAL ShutdownAttempt
  Var /GLOBAL MaxShutdownAttempts
  Var /GLOBAL TotalWaitTime
  
  ; Initialize variables
  StrCpy $ShutdownAttempt 0
  StrCpy $MaxShutdownAttempts 3
  StrCpy $TotalWaitTime 0
  
  ; Function to check if application is running using multiple methods
  Function CheckAppRunning
    StrCpy $ProcessFound 0
    
    ; Method 1: Check for window
    FindWindow $R0 "" "Windows Activity Tracker"
    ${If} $R0 != 0
      StrCpy $ProcessFound 1
      Goto check_done
    ${EndIf}
    
    ; Method 2: Check for process using tasklist
    ; This is more reliable for background processes
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
  
  ; Function to force close application
  Function ForceCloseApp
    ; Try multiple process names and force close methods
    
    ; Method 1: Standard executable name
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
  
  ; Try graceful shutdown with retries
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
    ${If} $ProcessFound == 0
      Goto shutdown_success
    ${EndIf}
  ${EndIf}
  
  ; All attempts failed - show manual close dialog with better instructions
  manual_close_dialog:
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
    ${If} $ProcessFound == 0
      Goto shutdown_success
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
