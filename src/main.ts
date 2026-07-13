import { Notice, Plugin } from 'obsidian'
import { CarbonVoiceSettings, DEFAULT_SETTINGS } from './types'
import { CarbonVoiceSettingTab } from './settings'
import { CarbonVoiceSync } from './sync'
import { CarbonVoiceView, CARBON_VOICE_VIEW } from './view'

export default class CarbonVoiceSyncPlugin extends Plugin {
  settings!: CarbonVoiceSettings
  sync!: CarbonVoiceSync
  private syncIntervalId: number | null = null
  private isSyncing = false

  async onload() {
    await this.loadSettings()
    this.sync = new CarbonVoiceSync(this)

    this.addSettingTab(new CarbonVoiceSettingTab(this.app, this))

    this.registerView(CARBON_VOICE_VIEW, leaf => new CarbonVoiceView(leaf, this))

    // The mic ribbon opens the Carbon Voice panel in the main area. Sync is available from the
    // panel's Sync button and the "Sync now" command.
    this.addRibbonIcon('microphone', 'Open Carbon Voice', () => this.activateView())

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => this.runSync(),
    })

    this.addCommand({
      id: 'open-panel',
      name: 'Open panel',
      callback: () => this.activateView(),
    })

    this.registerSyncInterval()

    if (this.settings.syncOnStartup && this.settings.apiToken) {
      this.runSync()
    }
  }

  onunload() {
    if (this.syncIntervalId != null) window.clearInterval(this.syncIntervalId)
  }

  // Manual / scheduled incremental sync.
  async runSync(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Carbon Voice: A sync is already running')
      return
    }
    if (!this.settings.apiToken) {
      new Notice('Carbon Voice: Add an API token in settings first')
      return
    }
    this.isSyncing = true
    const notice = new Notice('Carbon Voice: Syncing…', 0)
    try {
      const res = await this.sync.syncIncremental()
      notice.hide()
      if (res.firstRun) {
        new Notice(
          'Carbon Voice: Connected. New activity syncs from now — use Import history for past data.'
        )
      } else {
        new Notice(
          `Carbon Voice: Synced ${res.conversations} conversation file(s), ${res.voiceMemos} voice memo(s)`
        )
      }
    } catch (err) {
      notice.hide()
      new Notice(`Carbon Voice: Sync failed — ${errMessage(err)}`)
    } finally {
      this.isSyncing = false
      this.refreshPanel()
    }
  }

  // Explicit per-category historical import triggered from settings.
  async runImport(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Carbon Voice: A sync is already running')
      return
    }
    if (!this.settings.apiToken) {
      new Notice('Carbon Voice: Add an API token in settings first')
      return
    }
    this.isSyncing = true
    const notice = new Notice('Carbon Voice: Importing history, this may take a moment…', 0)
    try {
      const res = await this.sync.importHistory(
        this.settings.conversationHistoryWindow,
        this.settings.voiceMemoHistoryWindow
      )
      notice.hide()
      new Notice(
        `Carbon Voice: Imported ${res.conversations} conversation file(s), ${res.voiceMemos} voice memo(s)`
      )
    } catch (err) {
      notice.hide()
      new Notice(`Carbon Voice: Import failed — ${errMessage(err)}`)
    } finally {
      this.isSyncing = false
      this.refreshPanel()
    }
  }

  // Opens (or reveals) the Carbon Voice panel as a tab in the main editor area. Reuses an existing
  // Carbon Voice leaf if one is already open (sidebar or main) rather than spawning duplicates.
  // Kicks off a sync on open so the panel reflects fresh data (skipped when no token is set;
  // runSync itself no-ops if a sync is already running).
  async activateView(): Promise<void> {
    const { workspace } = this.app
    let leaf = workspace.getLeavesOfType(CARBON_VOICE_VIEW)[0]
    if (!leaf) {
      leaf = workspace.getLeaf('tab')
      await leaf.setViewState({ type: CARBON_VOICE_VIEW, active: true })
    }
    workspace.revealLeaf(leaf)
    if (this.settings.apiToken) void this.runSync()
  }

  // Re-renders any open panel so its status line stays live after a sync from anywhere.
  refreshPanel(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CARBON_VOICE_VIEW)) {
      const view = leaf.view
      if (view instanceof CarbonVoiceView) view.render()
    }
  }

  // Opens this plugin's settings tab (used by the panel's Settings button).
  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } })
      .setting
    setting?.open()
    setting?.openTabById(this.manifest.id)
  }

  registerSyncInterval(): void {
    if (this.syncIntervalId != null) {
      window.clearInterval(this.syncIntervalId)
      this.syncIntervalId = null
    }
    const minutes = this.settings.syncInterval
    if (minutes && minutes > 0) {
      this.syncIntervalId = window.setInterval(
        () => {
          if (this.settings.apiToken) this.runSync()
        },
        minutes * 60 * 1000
      )
      this.registerInterval(this.syncIntervalId)
    }
  }

  async loadSettings() {
    const data: Record<string, unknown> = { ...((await this.loadData()) ?? {}) }
    // Migrate the earlier boolean `downloadAudio` toggle to the `audioMode` setting.
    if (data.audioMode == null && typeof data.downloadAudio === 'boolean') {
      data.audioMode = data.downloadAudio ? 'download' : 'off'
    }
    delete data.downloadAudio
    // The removed inline 'embed' player falls back to link-only.
    if (data.audioMode === 'embed') data.audioMode = 'off'
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data)
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error'
}
