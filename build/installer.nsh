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
  
  ; Initialize variables
  StrCpy $ShutdownAttempt 0
  StrCpy $MaxShutdownAttempts 3
  
  ; Function to check if application is running using FindWindow
  Function CheckAppRunning
    StrCpy $ProcessFound 0
    FindWindow $R0 "" "Windows Activity Tracker"
    ${If} $R0 != 0
      StrCpy $ProcessFound 1
    ${EndIf}
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
    ; Use taskkill to force close
    ExecWait 'taskkill /F /IM "Windows Activity Tracker.exe" /T' $0
    
    ${If} $0 == 0
      Sleep 1000  ; Wait for process to terminate
      Call CheckAppRunning
      ${If} $ProcessFound == 0
        StrCpy $0 1  ; Success
      ${Else}
        StrCpy $0 0  ; Failed
      ${EndIf}
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
      Goto shutdown_loop
    ${EndIf}
  
  ; All attempts failed - show manual close dialog
  manual_close_dialog:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "Unable to close the application, please close it manually.$\n$\n" \
      "Please close 'Windows Activity Tracker' and click Retry.$\n$\n" \
      "Process: Windows Activity Tracker.exe" \
      IDRETRY retry_shutdown \
      IDCANCEL cancel_install
  
  retry_shutdown:
    Call CheckAppRunning
    ${If} $ProcessFound == 0
      Goto shutdown_success
    ${Else}
      Goto manual_close_dialog
    ${EndIf}
  
  cancel_install:
    Abort "Installation cancelled by user"
  
  shutdown_success:
!macroend
