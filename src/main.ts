import { Notice, Plugin } from 'obsidian'
import { CarbonVoiceSettings, DEFAULT_SETTINGS } from './types'
import { CarbonVoiceSettingTab } from './settings'
import { CarbonVoiceSync } from './sync'

export default class CarbonVoiceSyncPlugin extends Plugin {
  settings!: CarbonVoiceSettings
  sync!: CarbonVoiceSync
  private syncIntervalId: number | null = null
  private isSyncing = false

  async onload() {
    await this.loadSettings()
    this.sync = new CarbonVoiceSync(this)

    this.addSettingTab(new CarbonVoiceSettingTab(this.app, this))

    this.addRibbonIcon('microphone', 'Sync Carbon Voice', () => this.runSync())

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => this.runSync(),
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
    }
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error'
}
