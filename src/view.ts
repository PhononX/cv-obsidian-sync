import { ItemView, Setting, WorkspaceLeaf } from 'obsidian'
import type CarbonVoiceSyncPlugin from './main'

export const CARBON_VOICE_VIEW = 'carbon-voice-view'

// A dedicated Carbon Voice panel (opens as a tab / side-leaf). Surfaces sync + import actions and
// status, and a shortcut into the "Conversations by Date" Bases view. The ribbon mic still does
// one-tap sync; this is the richer home surface, opened from its own ribbon icon / command.
export class CarbonVoiceView extends ItemView {
  private plugin: CarbonVoiceSyncPlugin

  constructor(leaf: WorkspaceLeaf, plugin: CarbonVoiceSyncPlugin) {
    super(leaf)
    this.plugin = plugin
  }

  getViewType(): string {
    return CARBON_VOICE_VIEW
  }

  getDisplayText(): string {
    return 'Carbon Voice'
  }

  getIcon(): string {
    return 'microphone'
  }

  async onOpen(): Promise<void> {
    this.render()
  }

  // Rebuilds the panel from current settings. Public so the plugin can refresh it after a sync
  // that was triggered elsewhere (e.g. the ribbon mic), keeping the status line live.
  render(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('cv-panel')
    contentEl.createEl('h3', { text: 'Carbon Voice' })

    const s = this.plugin.settings

    new Setting(contentEl)
      .setName(s.apiToken ? s.connectedUserName || 'Connected' : 'Not connected')
      .setDesc(
        s.lastSyncTimestamp
          ? `Last synced ${new Date(s.lastSyncTimestamp).toLocaleString()}`
          : 'Not synced yet'
      )

    new Setting(contentEl).setName('Sync now').setDesc('Pull new activity').addButton(btn =>
      btn
        .setButtonText('Sync')
        .setCta()
        .onClick(async () => {
          await this.plugin.runSync()
          this.render()
        })
    )

    new Setting(contentEl)
      .setName('Import history')
      .setDesc('Fetch older data for the configured windows')
      .addButton(btn =>
        btn.setButtonText('Import').onClick(async () => {
          await this.plugin.runImport()
          this.render()
        })
      )

    new Setting(contentEl)
      .setName('Conversations by date')
      .setDesc('Open the inbox-style Bases view (needs the core Bases plugin)')
      .addButton(btn =>
        btn.setButtonText('Open').onClick(() => {
          const root = s.syncFolder.trim() || 'Carbon Voice'
          this.app.workspace.openLinkText(`${root}/Conversations by Date.base`, '', true)
        })
      )

    new Setting(contentEl).setName('Settings').addButton(btn =>
      btn.setButtonText('Open').onClick(() => this.plugin.openSettings())
    )
  }
}
