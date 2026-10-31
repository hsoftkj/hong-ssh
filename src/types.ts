export type AuthType = 'password' | 'privateKey' | 'agent'
export type ConnectionProtocol = 'ssh' | 'remoteDesktop'
export type ConnectionMode = 'direct' | 'webrtc'
export type HostKeyPolicy = 'accept-new' | 'strict' | 'insecure'
export type AppTheme =
  | 'light'
  | 'flat'
  | 'skeuomorphic'
  | 'handdrawn'
  | 'watercolor'
  | 'pixel'
  | 'neumorphic'
  | 'cyberpunk'
  | 'dark'
  | 'paper'
  | 'cute'
  | 'minimal'
  | 'swiss'
  | 'neon'
  | 'metal'
  | 'wood'
  | 'fabric'
  | 'gothic'
  | 'forest'
  | 'luxury'
  | 'eyecare'
export type TerminalThemeName = 'xshell' | 'solarized' | 'light'
export type CursorStyle = 'block' | 'underline' | 'bar'
export type RightClickAction = 'paste' | 'contextMenu' | 'nothing'

export interface Folder {
  id: string
  name: string
  parentId: string | null
  expanded: boolean
  order: number
}

export interface Connection {
  id: string
  folderId: string | null
  protocol: ConnectionProtocol
  connectionMode?: ConnectionMode
  relayUrl?: string
  relayDeviceId?: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath: string
  description: string
  color: string
  terminalType: string
  encoding: string
  initCommand: string
  hostKeyPolicy: HostKeyPolicy
  keepaliveInterval: number
  remoteQuality?: number
  remoteRefreshMs?: number
  order: number
  createdAt: number
  updatedAt: number
  lastConnectedAt: number
  importedFrom: string
  hasPassword: boolean
  hasPassphrase: boolean
  encrypted: boolean
}

export interface KnownHost {
  host: string
  fingerprint: string
  algorithm: string
  addedAt: number
}

export interface Settings {
  theme: AppTheme
  terminalTheme: TerminalThemeName
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  copyOnSelect: boolean
  rightClick: RightClickAction
  confirmClose: boolean
  autoReconnect: boolean
  autoReconnectAttempts: number
  sidebarVisible: boolean
  sidebarWidth: number
  sftpWidth: number
  hideSidebarScrollbar: boolean
  showQuickCommands: boolean
  terminalType: string
  keepaliveInterval: number
  hostKeyPolicy: HostKeyPolicy
  showStatusBar: boolean
  bell: boolean
  remoteEnabled: boolean
  relayEnabled: boolean
  relayUrl: string
  relayToken: string
  relayDeviceId: string
  inspectionDiskThreshold: number
}

export interface AppState {
  version: number
  folders: Folder[]
  connections: Connection[]
  settings: Settings
  knownHosts: KnownHost[]
  dataDir: string
  secretsEncrypted: boolean
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  dataDir: string
  isDev: boolean
}

export interface RemoteStatus {
  running: boolean
  port: number
  clients: number
  error?: string
}

export interface ConnectionDraft {
  id?: string
  folderId: string | null
  protocol?: ConnectionProtocol
  connectionMode?: ConnectionMode
  relayUrl?: string
  relayDeviceId?: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath: string
  description: string
  color: string
  terminalType: string
  initCommand: string
  hostKeyPolicy: HostKeyPolicy
  keepaliveInterval: number
  remoteQuality?: number
  remoteRefreshMs?: number
  password?: string
  passphrase?: string
  rememberPassword?: boolean
  rememberPassphrase?: boolean
  clearPassword?: boolean
  clearPassphrase?: boolean
}

export type SessionStatus =
  | 'connecting'
  | 'opening-shell'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnecting'

export interface SshDataEvent {
  sessionId: string
  data: string
}

export interface SshStatusEvent {
  sessionId: string
  status: SessionStatus
  message: string
  connectionId: string
  host: string
  username: string
  port: number
  code?: string
  attempt?: number
  fingerprint?: string
  reconnecting?: boolean
}

export interface SshClosedEvent {
  sessionId: string
  reason: string
  code?: string
  message?: string
  reconnectable?: boolean
}

export interface SshHostKeyEvent {
  sessionId: string
  hostKey: string
  fingerprint: string
  algorithm: string
  status: 'new' | 'changed'
}

export interface SystemInfo {
  host: string
  port: number
  username: string
  ip: string
  hostname: string
  osName: string
  kernel: string
  uptime: string
  cpuCount: number
  memoryTotal: number
  memoryUsed: number
}

export interface SystemInfoEvent {
  sessionId: string
  info: SystemInfo
}

export interface SystemStats {
  cpuPercent: number | null
  memoryPercent: number
  memoryUsed: number
  memoryTotal: number
}

export interface SystemStatsEvent {
  sessionId: string
  stats: SystemStats
}

export interface ConfirmQuitEvent {
  active: number
}

export type MenuAction =
  | 'new-connection'
  | 'import-xshell'
  | 'export-config'
  | 'close-tab'
  | 'copy'
  | 'paste'
  | 'find'
  | 'select-all'
  | 'clear'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'toggle-sidebar'
  | 'toggle-files'
  | 'toggle-theme'
  | 'cycle-terminal-theme'
  | 'reconnect'
  | 'disconnect'
  | 'next-tab'
  | 'previous-tab'
  | 'screenshot'
  | 'toggle-recording'
  | 'settings'
  | 'shortcuts'
  | 'about'

export interface SftpEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink'
  size: number
  mtime: number
  mode: number
  permissions: string
}

export interface SftpListResult {
  path: string
  home: string
  entries: SftpEntry[]
}

export type SftpTransferStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

export interface SftpProgressEvent {
  sessionId: string
  transferId: string
  direction: 'upload' | 'download'
  name: string
  status: SftpTransferStatus
  transferred: number
  total: number
  percent: number
  resumed?: boolean
  remotePath: string
  localPath: string
  error?: string
}

export interface SftpTransferSummary {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  name: string
  total: number
  status: SftpTransferStatus
  resumed?: boolean
}

export interface SftpStartResult {
  started: boolean
  conflicts: string[]
  transfers: SftpTransferSummary[]
}

export interface DragDownloadItem {
  path: string
  name: string
  isDirectory: boolean
}

export interface SftpDragDownloadEvent {
  sessionId: string
  name: string
  localPath: string
}

export interface SftpDragErrorEvent {
  sessionId: string
  name: string
  message: string
}

export interface SftpDragCancelEvent {
  sessionId: string
  name: string
}

export interface TestResult {
  ok: boolean
  message: string
  elapsed: number
  fingerprint?: string
}

export type InspectionStatus = 'ok' | 'alert' | 'error' | 'skipped'

export interface InspectionDisk {
  filesystem: string
  mount: string
  sizeKb: number
  usedKb: number
  availableKb: number
  usagePercent: number
}

export interface InspectionResult {
  connectionId: string
  name: string
  host: string
  port: number
  username: string
  protocol: ConnectionProtocol
  status: InspectionStatus
  message: string
  disks: InspectionDisk[]
  alerts: InspectionDisk[]
  elapsed: number
}

export interface InspectionProgressEvent {
  runId: string
  index: number
  total: number
  result: InspectionResult
}

export interface InspectionSummary {
  runId: string
  threshold: number
  aborted: boolean
  startedAt: number
  finishedAt: number
  total: number
  results: InspectionResult[]
}

export interface ImportSummary {
  files: number
  sessions: number
  unique: number
  duplicates: number
  folders: number
  withPassword: number
  portablePasswords: number
  xshellPasswords: number
  errors: string[]
  imported: number
  skippedExisting: number
  passwordsImported: number
  passphrasesImported: number
}

export interface ImportResult {
  root: string
  summary: ImportSummary
  state: AppState
}

export interface XshellExportSummary {
  directory: string
  files: number
  folders: number
  connections: number
  passwords: number
  passphrases: number
}

export interface ScreenRecordingStatus {
  recording: boolean
  startedAt?: number
  path?: string
  error?: string
}

export interface ScreenshotResult {
  cancelled?: boolean
  action?: 'copy' | 'save' | 'pin'
  path?: string
  copied?: boolean
}

export interface HongSshApi {
  platform: string
  versions: { electron: string; chrome: string; node: string }
  appInfo(): Promise<AppInfo>
  checkForUpdates(): Promise<Record<string, unknown>>
  getUpdateState(): Promise<Record<string, unknown> | null>
  getUpdateInfo(): Promise<Record<string, unknown> | null>
  loadState(): Promise<AppState>
  saveSettings(patch: Partial<Settings>): Promise<AppState>
  saveConnection(payload: ConnectionDraft): Promise<AppState>
  deleteConnection(id: string): Promise<AppState>
  saveFolder(payload: {
    id?: string
    name: string
    parentId: string | null
    expanded?: boolean
  }): Promise<AppState>
  deleteFolder(id: string): Promise<AppState>
  openRemoteWindow(connectionId: string): Promise<boolean>
  moveItems(payload: {
    folderIds: string[]
    connectionIds: string[]
    targetFolderId: string | null
    anchorConnectionId?: string | null
    anchorPosition?: 'before' | 'after'
    anchorFolderId?: string | null
    anchorFolderPosition?: 'before' | 'after'
  }): Promise<AppState>
  pickPrivateKey(): Promise<string>
  pickFolder(): Promise<string>
  pickFiles(): Promise<string[]>
  pickUploadFolders(): Promise<string[]>
  pickDownloadDirectory(): Promise<string>
  importXshell(): Promise<ImportResult | null>
  importXshellFrom(directory: string): Promise<ImportResult>
  exportXshell(): Promise<XshellExportSummary | null>
  testConnection(payload: {
    connection: ConnectionDraft
    password?: string
    passphrase?: string
  }): Promise<TestResult>
  runInspection(payload: {
    runId: string
    connectionIds: string[]
    threshold: number
  }): Promise<InspectionSummary>
  cancelInspection(runId: string): Promise<boolean>
  openSession(payload: {
    sessionId: string
    connectionId: string
    password?: string
    passphrase?: string
    rememberPassword?: boolean
    rememberPassphrase?: boolean
    cols: number
    rows: number
  }): Promise<{ sessionId: string }>
  writeSession(sessionId: string, data: string): Promise<boolean>
  resizeSession(sessionId: string, cols: number, rows: number): Promise<boolean>
  reconnectSession(sessionId: string): Promise<{ sessionId: string }>
  disconnectSession(sessionId: string, destroy?: boolean): Promise<boolean>
  sftpHome(sessionId: string): Promise<string>
  sftpList(sessionId: string, path: string): Promise<SftpListResult>
  sftpMkdir(sessionId: string, path: string): Promise<string>
  sftpRename(sessionId: string, from: string, to: string): Promise<string>
  sftpRemove(sessionId: string, path: string, recursive?: boolean): Promise<string>
  sftpUpload(payload: {
    sessionId: string
    localPaths: string[]
    remoteDir: string
    overwrite?: boolean
  }): Promise<SftpStartResult>
  sftpDownload(payload: {
    sessionId: string
    remotePaths: string[]
    localDir: string
    overwrite?: boolean
  }): Promise<SftpStartResult>
  sftpCancel(transferId: string): Promise<boolean>
  startDragDownload(
    sessionId: string,
    items: DragDownloadItem[],
    dragImage?: string
  ): Promise<{ started: boolean; count: number }>
  openLocalPath(targetPath: string): Promise<boolean>
  deleteKnownHost(hostKey: string): Promise<AppState>
  clearKnownHosts(): Promise<AppState>
  openExternal(url: string): Promise<boolean>
  openDataFolder(): Promise<boolean>
  setWindowTitle(title: string): Promise<void>
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowIsMaximized(): Promise<boolean>
  windowClose(): Promise<void>
  confirmQuit(confirmed: boolean): Promise<boolean>
  clipboardWrite(text: string): void
  clipboardRead(): string
  getPathForFile(file: File): string
  readClipboardFiles(): Promise<string[]>
  startScreenRecording(): Promise<{ started: boolean; cancelled?: boolean }>
  stopScreenRecording(): Promise<{ path?: string }>
  startScreenshot(): Promise<ScreenshotResult>
  onSshData(callback: (event: SshDataEvent) => void): () => void
  onSshStatus(callback: (event: SshStatusEvent) => void): () => void
  onSshClosed(callback: (event: SshClosedEvent) => void): () => void
  onSshHostKey(callback: (event: SshHostKeyEvent) => void): () => void
  onSystemInfo(callback: (event: SystemInfoEvent) => void): () => void
  onSystemStats(callback: (event: SystemStatsEvent) => void): () => void
  onInspectionProgress(callback: (event: InspectionProgressEvent) => void): () => void
  onSftpProgress(callback: (event: SftpProgressEvent) => void): () => void
  onSftpDragDownload(callback: (event: SftpDragDownloadEvent) => void): () => void
  onSftpDragError(callback: (event: SftpDragErrorEvent) => void): () => void
  onSftpDragCancel(callback: (event: SftpDragCancelEvent) => void): () => void
  onWindowMaximized(callback: (maximized: boolean) => void): () => void
  onConfirmQuit(callback: (event: ConfirmQuitEvent) => void): () => void
  onRemoteStatus(callback: (event: RemoteStatus) => void): () => void
  onScreenRecordingStatus(callback: (event: ScreenRecordingStatus) => void): () => void
  onMenuAction(callback: (action: MenuAction) => void): () => void
}

declare global {
  interface Window {
    hongssh?: HongSshApi
  }
}
