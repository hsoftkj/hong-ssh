; HongSSH production NSIS hooks.
; customInit closes running copies before files are replaced. Do not use /T:
; during an in-app update the installer is a child of the Electron process.
!macro customCheckAppRunning
!macroend

!macro customInit
  DetailPrint "Closing running HongSSH..."
  nsExec::ExecToLog 'taskkill /F /IM HongSSH.exe'
  Pop $0
  Sleep 900
!macroend
