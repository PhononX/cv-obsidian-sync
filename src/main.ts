import { Notice, Plugin } from 'obsidian'
import { CarbonVoiceSettings, DEFAULT_SETTINGS } from './types'
import { CarbonVoiceSettingTab } from './settings'

export default class CarbonVoiceSyncPlugin extends Plugin {
  settings: CarbonVoiceSettings

  async onload() {
    await this.loadSettings()

    this.addSettingTab(new CarbonVoiceSettingTab(this.app, this))

    this.addRibbonIcon('microphone', 'Sync Carbon Voice', () => {
      new Notice('Carbon Voice: Sync coming soon')
    })

    this.addCommand({
      id: 'sync-carbon-voice',
      name: 'Sync Carbon Voice conversations',
      callback: () => new Notice('Carbon Voice: Sync coming soon'),
    })
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }
}
