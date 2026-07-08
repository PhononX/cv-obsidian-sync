import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian'
import type CarbonVoiceSyncPlugin from './main'
import { CarbonVoiceAPI } from './api'
import type {
  CarbonVoiceUser,
  CarbonVoiceChannel,
  CarbonVoiceWorkspace,
  CarbonVoiceFolder,
  WorkspaceType,
  WorkspaceRole,
  SyncScope,
  AudioMode,
} from './types'
import { ASYNC_MEETING_PREFIX } from './types'

// Small first batch for a snappy initial load, then larger pages — mirrors the reference client.
const CHANNEL_FIRST_PAGE_SIZE = 20
const CHANNEL_PAGE_SIZE = 200
const WORKSPACE_PAGE_SIZE = 100

class TokenModal extends Modal {
  private token: string
  private onSuccess: (token: string, user: CarbonVoiceUser) => void
  private statusEl: HTMLElement | null = null

  constructor(
    app: App,
    existingToken: string,
    onSuccess: (token: string, user: CarbonVoiceUser) => void
  ) {
    super(app)
    this.token = existingToken
    this.onSuccess = onSuccess
  }

  onOpen() {
    const { contentEl } = this
    this.setTitle('Connect Carbon Voice')
    contentEl.createEl('p', {
      text: 'Generate a Personal Access Token in the Carbon Voice app:',
      cls: 'setting-item-description',
    })
    const steps = contentEl.createEl('ol', { cls: 'setting-item-description' })
    steps.createEl('li', { text: 'Open the Profile menu.' })
    steps.createEl('li', { text: 'Select Integrations, then Integration Credentials.' })
    steps.createEl('li', { text: 'Create a token and paste it below.' })

    new Setting(contentEl)
      .setName('API token')
      .addText(text => {
        text
          .setPlaceholder('Paste your token here')
          .setValue(this.token)
          .onChange(value => {
            this.token = value.trim()
            this.statusEl?.addClass('cv-hidden')
          })
        text.inputEl.type = 'password'
        text.inputEl.addClass('cv-token-input')
      })

    this.statusEl = contentEl.createDiv({ cls: 'cv-connect-status cv-hidden' })

    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Connect')
          .setCta()
          .onClick(async () => {
            if (!this.token) return
            btn.setButtonText('Connecting…')
            btn.setDisabled(true)
            this.statusEl?.addClass('cv-hidden')

            try {
              const api = new CarbonVoiceAPI(this.token)
              const user = await api.getCurrentUser()
              this.onSuccess(this.token, user)
              this.close()
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Unknown error'
              if (this.statusEl) {
                this.statusEl.removeClass('cv-hidden')
                this.statusEl.addClass('mod-error')
                this.statusEl.setText(`✗ ${msg}`)
              }
              btn.setButtonText('Connect')
              btn.setDisabled(false)
            }
          })
      )
      .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
  }

  onClose() {
    this.contentEl.empty()
  }
}

export class CarbonVoiceSettingTab extends PluginSettingTab {
  plugin: CarbonVoiceSyncPlugin

  // Cached conversation list, lazily paged in when the "Selected conversations" scope is active.
  private channels: CarbonVoiceChannel[] | null = null
  private channelsLoading = false
  private channelsError: string | null = null
  private channelsHasMore = true
  // Epoch-ms of the oldest channel loaded so far; the next "older" page starts from here.
  private channelsCursorMs: number | null = null

  // Workspaces are a small, bounded set, so we load them fully (all pages) when the
  // "By workspace" scope is active. Guest membership is resolved by querying the API's
  // roles filter rather than reading a field off the workspace object.
  private workspaces: CarbonVoiceWorkspace[] | null = null
  private workspacesLoading = false
  private workspacesError: string | null = null
  private guestWorkspaceIds = new Set<string>()

  // Voice-memo folders (full tree), loaded fully when the "By folder" scope is active.
  private folders: CarbonVoiceFolder[] | null = null
  private foldersLoading = false
  private foldersError: string | null = null

  // Filter text for each dual-listbox, persisted so it survives a "Load more" re-render.
  private channelFilter = ''
  private workspaceFilter = ''
  private folderFilter = ''

  constructor(app: App, plugin: CarbonVoiceSyncPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    // ── Synced Account ───────────────────────────────────────────────────────

    new Setting(containerEl).setName('Synced account').setHeading()

    const {
      apiToken,
      connectedUserId,
      connectedUserName,
      connectedUserAvatarUrl,
      connectedIdentityEmails,
      lastTokenValidated,
    } = this.plugin.settings

    if (!apiToken) {
      new Setting(containerEl)
        .setName('No API token set')
        .setDesc('Add a token to connect your Carbon Voice account')
        .addButton(btn =>
          btn
            .setButtonText('Add token')
            .setCta()
            .onClick(() => this.openTokenModal())
        )
    } else {
      const name = connectedUserName ?? 'Unknown Account'
      const idPart = connectedUserId ? `User ID: ${connectedUserId}` : ''
      const validatedPart = lastTokenValidated
        ? `Token last validated ${new Date(lastTokenValidated).toLocaleString()}`
        : 'Validating…'
      const validatedDesc = idPart ? `${idPart} · ${validatedPart}` : validatedPart

      const accountSetting = new Setting(containerEl)
        .setDesc(validatedDesc)
        .addButton(btn =>
          btn.setButtonText('Change token').onClick(() => this.openTokenModal())
        )

      this.buildAccountNameEl(
        accountSetting.nameEl,
        name,
        connectedIdentityEmails ?? [],
        connectedUserAvatarUrl ?? null
      )

      this.validateToken(accountSetting.descEl, accountSetting.nameEl)
    }

    // ── Sync ────────────────────────────────────────────────────────────────

    new Setting(containerEl).setName('Sync').setHeading()

    new Setting(containerEl)
      .setName('Sync folder')
      .setDesc('Root vault folder where all synced content is written')
      .addText(text =>
        text
          .setPlaceholder('Carbon Voice')
          .setValue(this.plugin.settings.syncFolder)
          .onChange(async value => {
            this.plugin.settings.syncFolder = value.trim() || 'Carbon Voice'
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Sync interval')
      .setDesc('How often to automatically sync in the background')
      .addDropdown(drop =>
        drop
          .addOption('0', 'Manual only')
          .addOption('5', 'Every 5 minutes')
          .addOption('15', 'Every 15 minutes')
          .addOption('30', 'Every 30 minutes')
          .addOption('60', 'Every hour')
          .setValue(String(this.plugin.settings.syncInterval))
          .onChange(async value => {
            this.plugin.settings.syncInterval = parseInt(value)
            await this.plugin.saveSettings()
            this.plugin.registerSyncInterval()
          })
      )

    new Setting(containerEl)
      .setName('Include transcripts')
      .setDesc('When off, message transcripts are omitted from notes')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.includeTranscripts)
          .onChange(async value => {
            this.plugin.settings.includeTranscripts = value
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Link people & workspaces')
      .setDesc(
        'Create People and Workspace notes and link participants, senders and workspaces so the graph and backlinks connect everything'
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.linkNotes)
          .onChange(async value => {
            this.plugin.settings.linkNotes = value
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Audio playback')
      .setDesc(
        'Download: save audio into the vault for offline playback (uses vault space). Off: link out to Carbon Voice only.'
      )
      .addDropdown(drop =>
        drop
          .addOption('download', 'Download for offline')
          .addOption('off', 'Off (link only)')
          .setValue(this.plugin.settings.audioMode)
          .onChange(async value => {
            this.plugin.settings.audioMode = value as AudioMode
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Automatically sync when Obsidian opens')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async value => {
            this.plugin.settings.syncOnStartup = value
            await this.plugin.saveSettings()
          })
      )

    const lastSynced = this.plugin.settings.lastSyncTimestamp
    new Setting(containerEl)
      .setName('Last synced')
      .setDesc(lastSynced ? new Date(lastSynced).toLocaleString() : 'Never')

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Trigger an immediate sync')
      .addButton(btn =>
        btn
          .setButtonText('Sync now')
          .setCta()
          .onClick(async () => {
            await this.plugin.runSync()
            this.display()
          })
      )

    // ── Conversation scope ──────────────────────────────────────────────────

    new Setting(containerEl).setName('Conversation scope').setHeading()

    new Setting(containerEl)
      .setName('Scope')
      .setDesc('Sync every conversation, only those in chosen workspaces, or a hand-picked set')
      .addDropdown(drop =>
        drop
          .addOption('all', 'All conversations')
          .addOption('by_workspace', 'Conversations in selected workspaces')
          .addOption('by_conversation', 'Selected conversations')
          .setValue(this.plugin.settings.conversationScope)
          .onChange(async value => {
            this.plugin.settings.conversationScope = value as SyncScope
            await this.plugin.saveSettings()
            this.display()
          })
      )

    if (this.plugin.settings.conversationScope === 'by_workspace') {
      this.renderWorkspaceSelector(containerEl, this.idAccessors('conversationWorkspaceIds'))
    } else if (this.plugin.settings.conversationScope === 'by_conversation') {
      this.renderConversationSelector(containerEl)
    }

    // ── Voice memo scope ────────────────────────────────────────────────────

    new Setting(containerEl).setName('Voice memo scope').setHeading()

    new Setting(containerEl)
      .setName('Scope')
      .setDesc('Sync every voice memo, only those in chosen workspaces, or specific folders')
      .addDropdown(drop =>
        drop
          .addOption('all', 'All voice memos')
          .addOption('by_workspace', 'Voice memos in selected workspaces')
          .addOption('by_folder', 'Voice memos in selected folders')
          .setValue(this.plugin.settings.voiceMemoScope)
          .onChange(async value => {
            this.plugin.settings.voiceMemoScope = value as SyncScope
            await this.plugin.saveSettings()
            this.display()
          })
      )

    if (this.plugin.settings.voiceMemoScope === 'by_workspace') {
      this.renderWorkspaceSelector(containerEl, this.idAccessors('voiceMemoWorkspaceIds'))
    } else if (this.plugin.settings.voiceMemoScope === 'by_folder') {
      this.renderFolderSelector(containerEl)
    }

    // ── Historical import ────────────────────────────────────────────────────

    new Setting(containerEl).setName('Historical import').setHeading()
    containerEl.createEl('p', {
      text: 'Forward sync only pulls new activity. Import older data once — both categories are fetched together in a single pass, each using its own window and honouring its scope above.',
      cls: 'setting-item-description',
    })

    this.renderHistoryWindow(containerEl, 'Conversation history', 'conversationHistoryWindow')
    this.renderHistoryWindow(containerEl, 'Voice memo history', 'voiceMemoHistoryWindow')

    new Setting(containerEl)
      .setName('Import now')
      .setDesc('Fetch and write both categories for the windows above')
      .addButton(btn =>
        btn
          .setButtonText('Import')
          .setCta()
          .onClick(async () => {
            await this.plugin.runImport()
            this.display()
          })
      )
  }

  private renderHistoryWindow(
    containerEl: HTMLElement,
    name: string,
    windowKey: 'conversationHistoryWindow' | 'voiceMemoHistoryWindow'
  ): void {
    new Setting(containerEl).setName(name).addDropdown(drop =>
      drop
        .addOption('7', 'Last 7 days')
        .addOption('30', 'Last 30 days')
        .addOption('90', 'Last 90 days')
        .addOption('365', 'Last year')
        .addOption('all', 'All time')
        .setValue(String(this.plugin.settings[windowKey]))
        .onChange(async value => {
          this.plugin.settings[windowKey] =
            value === 'all' ? 'all' : (parseInt(value) as 7 | 30 | 90 | 365)
          await this.plugin.saveSettings()
        })
    )
  }

  private channelName(c: CarbonVoiceChannel): string {
    return c.channel_name?.trim() || `Untitled ${c.type} (${c.channel_guid.slice(0, 8)})`
  }

  // sort_order is a date; the wire format may be epoch-ms (like the other channel timestamps)
  // or an ISO string, so normalise to epoch-ms for sorting/formatting.
  private sortOrderMs(c: CarbonVoiceChannel): number {
    const v = c.sort_order
    if (v == null) return 0
    if (typeof v === 'number') return v
    const parsed = Date.parse(v)
    return Number.isNaN(parsed) ? 0 : parsed
  }

  private channelSublabel(c: CarbonVoiceChannel): string {
    const parts: string[] = []
    if (c.workspace_name) parts.push(c.workspace_name)
    const ms = this.sortOrderMs(c)
    if (ms) parts.push(new Date(ms).toLocaleString())
    return parts.join(' · ')
  }

  // Pages backwards through /channels/recent, mirroring the reference client: always fetch
  // `older` starting from `now` (empty cache) or from the oldest channel already loaded.
  // last_updated_ts is epoch milliseconds; the `date` cursor is sent as an ISO timestamp.
  private async loadMoreChannels(): Promise<void> {
    if (this.channelsLoading) return
    this.channelsLoading = true
    this.channelsError = null
    try {
      const api = new CarbonVoiceAPI(this.plugin.settings.apiToken)
      const existing = this.channels ?? []
      const isFirstPage = existing.length === 0
      const limit = isFirstPage ? CHANNEL_FIRST_PAGE_SIZE : CHANNEL_PAGE_SIZE
      const cursorMs = isFirstPage ? Date.now() : this.channelsCursorMs ?? Date.now()

      const page = await api.getRecentChannels({
        limit,
        direction: 'older',
        date: new Date(cursorMs).toISOString(),
      })

      const seen = new Set(existing.map(c => c.channel_guid))
      const fresh = page.filter(c => !seen.has(c.channel_guid))
      this.channels = [...existing, ...fresh]

      // Advance the cursor to the oldest channel now loaded; if it can't move older, stop.
      const newOldestMs = this.channels.reduce(
        (min, c) => Math.min(min, c.last_updated_ts ?? Infinity),
        Infinity
      )
      const advanced = this.channelsCursorMs == null || newOldestMs < this.channelsCursorMs
      if (Number.isFinite(newOldestMs)) this.channelsCursorMs = newOldestMs
      this.channelsHasMore = page.length >= limit && fresh.length > 0 && advanced
    } catch (err) {
      this.channelsError = err instanceof Error ? err.message : 'Failed to load conversations'
    } finally {
      this.channelsLoading = false
      this.display()
    }
  }

  // Loads every workspace across the sections we display. Guest standard workspaces come from
  // a dedicated roles=guest query so we never have to infer role from the response body.
  private async loadWorkspaces(): Promise<void> {
    if (this.workspacesLoading) return
    this.workspacesLoading = true
    this.workspacesError = null
    try {
      const api = new CarbonVoiceAPI(this.plugin.settings.apiToken)
      const [nonGuest, guest, webcontact] = await Promise.all([
        this.fetchAllWorkspaces(api, {
          types: ['standard'],
          roles: ['admin', 'owner', 'creator', 'member'],
        }),
        this.fetchAllWorkspaces(api, { types: ['standard'], roles: ['guest'] }),
        this.fetchAllWorkspaces(api, { types: ['webcontact'] }),
      ])
      this.guestWorkspaceIds = new Set(guest.map(w => w.id))
      const byId = new Map<string, CarbonVoiceWorkspace>()
      for (const w of [...nonGuest, ...guest, ...webcontact]) byId.set(w.id, w)
      this.workspaces = [...byId.values()]
    } catch (err) {
      this.workspacesError = err instanceof Error ? err.message : 'Failed to load workspaces'
    } finally {
      this.workspacesLoading = false
      this.display()
    }
  }

  // Pages a single workspace query to completion via next_cursor / starting_after.
  private async fetchAllWorkspaces(
    api: CarbonVoiceAPI,
    params: { types?: WorkspaceType[]; roles?: WorkspaceRole[] }
  ): Promise<CarbonVoiceWorkspace[]> {
    const out: CarbonVoiceWorkspace[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    // Safety cap — workspaces are few; this only guards against a misbehaving cursor.
    for (let page = 0; page < 50; page++) {
      const res = await api.getWorkspaces({
        ...params,
        limit: WORKSPACE_PAGE_SIZE,
        ...(cursor ? { starting_after: cursor } : {}),
      })
      for (const w of res.results) {
        if (!seen.has(w.id)) {
          seen.add(w.id)
          out.push(w)
        }
      }
      if (!res.has_more || !res.next_cursor || res.next_cursor === cursor) break
      cursor = res.next_cursor
    }
    return out
  }

  // Reusable dual-listbox: Available items on the left (filterable + paged), Selected on the
  // right. Clicking a row moves it across. Moves re-render only the panes so filter/scroll
  // survive; "Load more" fetches a page and triggers a full settings re-render.
  private renderDualListbox(
    containerEl: HTMLElement,
    opts: {
      noun: string
      items: Array<{ id: string; label: string; sublabel: string; section?: string }> | null
      loading: boolean
      error: string | null
      hasMore: boolean
      filter: string
      // Section headers (with separator lines) for the Available pane, in display order.
      sectionOrder?: string[]
      getSelectedIds: () => string[]
      onFilter: (value: string) => void
      onLoad: () => void
      onRetry: () => void
      onAdd: (id: string) => Promise<void>
      onRemove: (id: string) => Promise<void>
    }
  ): void {
    if (!this.plugin.settings.apiToken) {
      new Setting(containerEl).setDesc(`Connect your account to choose ${opts.noun}s.`)
      return
    }

    if (opts.error) {
      new Setting(containerEl)
        .setName(`Could not load ${opts.noun}s`)
        .setDesc(opts.error)
        .addButton(btn => btn.setButtonText('Retry').onClick(() => opts.onRetry()))
      return
    }

    if (opts.items === null) {
      if (!opts.loading) opts.onLoad()
      new Setting(containerEl).setName(`Loading ${opts.noun}s…`)
      return
    }

    const items = opts.items
    let filterText = opts.filter

    const wrap = containerEl.createDiv({ cls: 'cv-duallist' })

    // ── Left pane: available ──
    const left = wrap.createDiv({ cls: 'cv-duallist__pane' })
    const leftHeader = left.createDiv({ cls: 'cv-duallist__header' })
    const filterInput = left.createEl('input', {
      type: 'text',
      cls: 'cv-duallist__filter',
    })
    filterInput.placeholder = `Filter ${opts.noun}s…`
    filterInput.value = filterText
    const leftList = left.createDiv({ cls: 'cv-duallist__list' })

    // ── Right pane: selected ──
    const right = wrap.createDiv({ cls: 'cv-duallist__pane' })
    const rightHeader = right.createDiv({ cls: 'cv-duallist__header' })
    const rightList = right.createDiv({ cls: 'cv-duallist__list' })

    const makeSectionHeader = (listEl: HTMLElement, title: string, isFirst: boolean) => {
      const h = listEl.createDiv({ cls: 'cv-duallist__section', text: title })
      if (!isFirst) h.addClass('is-divided')
    }

    const makeRow = (
      listEl: HTMLElement,
      item: { id: string; label: string; sublabel: string; section?: string },
      side: 'available' | 'selected'
    ) => {
      const row = listEl.createDiv({ cls: 'cv-duallist__row' })
      const text = row.createDiv()
      text.createDiv({ cls: 'cv-duallist__row-label', text: item.label })
      if (item.sublabel) {
        text.createDiv({ cls: 'cv-duallist__row-sublabel', text: item.sublabel })
      }
      row.createSpan({ cls: 'cv-duallist__icon', text: side === 'available' ? '+' : '×' })
      row.onclick = async () => {
        if (side === 'available') await opts.onAdd(item.id)
        else await opts.onRemove(item.id)
        renderPanes()
      }
    }

    const muted = (listEl: HTMLElement, text: string) => {
      listEl.createDiv({ cls: 'cv-duallist__muted', text })
    }

    const renderPanes = () => {
      const selected = opts.getSelectedIds()
      const selectedSet = new Set(selected)
      const f = filterText.trim().toLowerCase()
      const available = items.filter(
        i =>
          !selectedSet.has(i.id) &&
          (!f || i.label.toLowerCase().includes(f) || i.sublabel.toLowerCase().includes(f))
      )

      leftHeader.setText(`Available (${available.length})`)
      rightHeader.setText(`Selected (${selected.length})`)

      leftList.empty()
      if (available.length === 0) {
        muted(leftList, f ? 'No matches in loaded items' : `No ${opts.noun}s available`)
      } else if (!opts.sectionOrder) {
        available.forEach(i => makeRow(leftList, i, 'available'))
      } else {
        const groups = new Map<string, typeof available>()
        for (const i of available) {
          const s = i.section ?? ''
          const arr = groups.get(s) ?? []
          arr.push(i)
          groups.set(s, arr)
        }
        // Known sections first (in declared order), then any leftovers.
        const ordered = [
          ...opts.sectionOrder.filter(s => groups.has(s)),
          ...[...groups.keys()].filter(s => !opts.sectionOrder!.includes(s)),
        ]
        let firstSection = true
        for (const s of ordered) {
          const group = groups.get(s)
          if (!group || group.length === 0) continue
          makeSectionHeader(leftList, s || 'Other', firstSection)
          firstSection = false
          group.forEach(i => makeRow(leftList, i, 'available'))
        }
      }
      if (opts.hasMore) {
        const more = leftList.createDiv({
          cls: 'cv-duallist__more',
          text: opts.loading ? 'Loading…' : `Load more (filters loaded items only)`,
        })
        more.onclick = () => {
          more.setText('Loading…')
          opts.onLoad()
        }
      }

      rightList.empty()
      if (selected.length === 0) {
        muted(rightList, `None selected — nothing will sync until you add at least one`)
      } else {
        selected.forEach(id => {
          const item = items.find(i => i.id === id) ?? { id, label: id, sublabel: '' }
          makeRow(rightList, item, 'selected')
        })
      }
    }

    filterInput.oninput = () => {
      filterText = filterInput.value
      opts.onFilter(filterText)
      renderPanes()
    }

    renderPanes()
  }

  private renderConversationSelector(containerEl: HTMLElement): void {
    // Conversations are grouped under a per-workspace separator so each workspace can host an
    // "All async meetings in <workspace>" rule as its first row (mirrors the folder selector's
    // synthetic `root:<ws>` entries). Channels already carry their workspace name; we also pull
    // the full workspace list so the async-meeting rule is offered for every workspace, not just
    // ones whose channels have paged in yet.
    if (this.workspaces === null && !this.workspacesLoading) void this.loadWorkspaces()

    const wsNameById = new Map<string, string>()
    if (this.workspaces) for (const w of this.workspaces) wsNameById.set(w.id, w.name)
    if (this.channels) {
      for (const c of this.channels) {
        if (c.workspace_guid && !wsNameById.has(c.workspace_guid)) {
          wsNameById.set(c.workspace_guid, c.workspace_name || c.workspace_guid)
        }
      }
    }

    const wsName = (id: string) => wsNameById.get(id) ?? id
    const wsIds = [...wsNameById.keys()].sort((a, b) => {
      if (a === 'Personal') return -1
      if (b === 'Personal') return 1
      return wsName(a).localeCompare(wsName(b))
    })
    const sectionOrder = wsIds.map(wsName)

    // One "All async meetings" rule per workspace, listed first within its section.
    const asyncItems = wsIds.map(id => ({
      id: `${ASYNC_MEETING_PREFIX}${id}`,
      label: 'All async meetings',
      sublabel: `Auto-syncs every async meeting in ${wsName(id)}`,
      section: wsName(id),
    }))

    const channelItems =
      this.channels === null
        ? []
        : [...this.channels]
            .sort((a, b) => this.sortOrderMs(b) - this.sortOrderMs(a))
            .map(c => ({
              id: c.channel_guid,
              label: this.channelName(c),
              sublabel: this.channelSublabel(c),
              section: c.workspace_guid ? wsName(c.workspace_guid) : c.workspace_name || 'Other',
            }))

    const items = this.channels === null ? null : [...asyncItems, ...channelItems]

    this.renderDualListbox(containerEl, {
      noun: 'conversation',
      items,
      sectionOrder,
      loading: this.channelsLoading,
      error: this.channelsError,
      hasMore: this.channelsHasMore,
      filter: this.channelFilter,
      getSelectedIds: () => this.plugin.settings.conversationIds,
      onFilter: value => {
        this.channelFilter = value
      },
      onLoad: () => void this.loadMoreChannels(),
      onRetry: () => {
        this.channels = null
        this.channelsError = null
        this.channelsHasMore = true
        this.channelsCursorMs = null
        this.display()
      },
      onAdd: async id => {
        if (!this.plugin.settings.conversationIds.includes(id)) {
          this.plugin.settings.conversationIds.push(id)
          await this.plugin.saveSettings()
        }
      },
      onRemove: async id => {
        this.plugin.settings.conversationIds = this.plugin.settings.conversationIds.filter(
          x => x !== id
        )
        await this.plugin.saveSettings()
      },
    })
  }

  private workspaceSection(w: CarbonVoiceWorkspace): string {
    // The personal workspace is flagged by a sentinel id/guid of "Personal".
    if (w.id?.toLowerCase() === 'personal') return 'Personal'
    if (w.type === 'webcontact') return 'Business Carbon Links'
    // Guest membership comes from the roles=guest query, not a field on the object.
    if (this.guestWorkspaceIds.has(w.id)) return 'Guest Workspaces'
    return 'Workspaces'
  }

  // Add/remove accessors for a string[] setting, shared by every selector.
  private idAccessors(key: 'conversationIds' | 'conversationWorkspaceIds' | 'voiceMemoWorkspaceIds' | 'voiceMemoFolderIds') {
    return {
      getSelectedIds: () => this.plugin.settings[key],
      onAdd: async (id: string) => {
        if (!this.plugin.settings[key].includes(id)) {
          this.plugin.settings[key].push(id)
          await this.plugin.saveSettings()
        }
      },
      onRemove: async (id: string) => {
        this.plugin.settings[key] = this.plugin.settings[key].filter(x => x !== id)
        await this.plugin.saveSettings()
      },
    }
  }

  // Workspace selector, reused for both conversation and voice-memo workspace scopes.
  private renderWorkspaceSelector(
    containerEl: HTMLElement,
    sel: {
      getSelectedIds: () => string[]
      onAdd: (id: string) => Promise<void>
      onRemove: (id: string) => Promise<void>
    }
  ): void {
    const items =
      this.workspaces === null
        ? null
        : this.workspaces.map(w => ({
            id: w.id,
            label: w.name,
            sublabel: w.vanity_name ?? '',
            section: this.workspaceSection(w),
          }))

    this.renderDualListbox(containerEl, {
      noun: 'workspace',
      items,
      sectionOrder: ['Personal', 'Workspaces', 'Guest Workspaces', 'Business Carbon Links'],
      loading: this.workspacesLoading,
      error: this.workspacesError,
      hasMore: false, // all workspaces are loaded up front
      filter: this.workspaceFilter,
      getSelectedIds: sel.getSelectedIds,
      onFilter: value => {
        this.workspaceFilter = value
      },
      onLoad: () => void this.loadWorkspaces(),
      onRetry: () => {
        this.workspaces = null
        this.workspacesError = null
        this.guestWorkspaceIds = new Set()
        this.display()
      },
      onAdd: sel.onAdd,
      onRemove: sel.onRemove,
    })
  }

  // ── Folders ─────────────────────────────────────────────────────────────

  private async loadFolders(): Promise<void> {
    if (this.foldersLoading) return
    this.foldersLoading = true
    this.foldersError = null
    try {
      const api = new CarbonVoiceAPI(this.plugin.settings.apiToken)
      const roots = await api.getFolders({
        type: 'voicememo',
        include_all_tree: true,
        sort_by: 'name',
        sort_direction: 'ASC',
      })
      // Flatten roots + any nested subfolders into one list, deduped by id.
      const byId = new Map<string, CarbonVoiceFolder>()
      const walk = (f: CarbonVoiceFolder) => {
        if (byId.has(f.id)) return
        byId.set(f.id, f)
        f.subfolders?.forEach(walk)
      }
      roots.forEach(walk)
      this.folders = [...byId.values()]
    } catch (err) {
      this.foldersError = err instanceof Error ? err.message : 'Failed to load folders'
    } finally {
      this.foldersLoading = false
      this.display()
    }
  }

  // Builds "Root / Parent / This" from the folder's ancestor-id path (parent-first).
  private folderFullPath(f: CarbonVoiceFolder, nameById: Map<string, string>): string {
    const ancestors = [...(f.path ?? [])].reverse().map(id => nameById.get(id) ?? '…')
    return [...ancestors, f.name].join(' / ')
  }

  private renderFolderSelector(containerEl: HTMLElement): void {
    // Folder names can collide across workspaces, so we group folders under a per-workspace
    // separator. Folders only carry workspace_id, so resolve names from the workspace cache
    // (loaded on demand); the view re-renders with proper names once it arrives.
    if (this.workspaces === null && !this.workspacesLoading) void this.loadWorkspaces()
    const wsNameById = new Map<string, string>()
    if (this.workspaces) for (const w of this.workspaces) wsNameById.set(w.id, w.name)
    const wsSection = (wsId: string) =>
      wsNameById.get(wsId) ?? (wsId === 'Personal' ? 'Personal' : wsId)

    const nameById = new Map<string, string>()
    if (this.folders) for (const f of this.folders) nameById.set(f.id, f.name)

    // One separator per workspace that has folders; personal workspace first, then alphabetical.
    const wsIds = this.folders ? [...new Set(this.folders.map(f => f.workspace_id))] : []
    wsIds.sort((a, b) => {
      if (a === 'Personal') return -1
      if (b === 'Personal') return 1
      return wsSection(a).localeCompare(wsSection(b))
    })
    const sectionOrder = wsIds.map(wsSection)

    // A synthetic "root" target per workspace, for memos that live at the workspace root and
    // aren't in any folder. The sync engine treats `root:<workspace_id>` as exactly that.
    const rootItems = wsIds.map(wsId => ({
      id: `root:${wsId}`,
      label: `${wsSection(wsId)} — root`,
      sublabel: 'Memos not in any folder',
      section: wsSection(wsId),
    }))

    const items =
      this.folders === null
        ? null
        : [
            ...rootItems,
            ...this.folders
              .map(f => {
                const count = f.total_nested_messages_count
                return {
                  id: f.id,
                  label: this.folderFullPath(f, nameById),
                  sublabel: `${count} memo${count === 1 ? '' : 's'}`,
                  section: wsSection(f.workspace_id),
                }
              })
              .sort((a, b) => a.label.localeCompare(b.label)),
          ]

    this.renderDualListbox(containerEl, {
      noun: 'folder',
      items,
      sectionOrder,
      loading: this.foldersLoading,
      error: this.foldersError,
      hasMore: false, // full tree is loaded up front
      filter: this.folderFilter,
      onFilter: value => {
        this.folderFilter = value
      },
      onLoad: () => void this.loadFolders(),
      onRetry: () => {
        this.folders = null
        this.foldersError = null
        this.display()
      },
      ...this.idAccessors('voiceMemoFolderIds'),
    })
  }

  private buildAccountNameEl(
    nameEl: HTMLElement,
    name: string,
    emails: string[],
    avatarUrl: string | null
  ): void {
    nameEl.empty()

    if (avatarUrl) {
      const img = nameEl.createEl('img', { cls: 'cv-account-avatar' })
      img.src = avatarUrl
    }

    nameEl.appendText(name)

    if (emails.length > 0) {
      const emailSpan = nameEl.createEl('span', {
        cls: 'cv-account-email',
        text: ` · ${emails[0]}`,
      })
      if (emails.length > 1) {
        emailSpan.title = emails.slice(1).join('\n')
        emailSpan.addClass('mod-has-more')
      }
    }
  }

  private async validateToken(descEl: HTMLElement, nameEl: HTMLElement): Promise<void> {
    try {
      const api = new CarbonVoiceAPI(this.plugin.settings.apiToken)
      const user = await api.getCurrentUser()

      const emails = user.identities?.map(id => id.provider_email).filter((e): e is string => !!e) ?? []
      const avatarUrl = user.image_url

      this.plugin.settings.connectedUserId = user.user_guid
      this.plugin.settings.connectedUserName = `${user.first_name} ${user.last_name}`.trim()
      this.plugin.settings.connectedUserAvatarUrl = avatarUrl
      this.plugin.settings.connectedIdentityEmails = emails
      this.plugin.settings.lastTokenValidated = new Date().toISOString()
      await this.plugin.saveSettings()

      descEl.removeClass('cv-desc-error')
      descEl.setText(`User ID: ${user.user_guid} · Token last validated ${new Date().toLocaleString()}`)

      this.buildAccountNameEl(nameEl, `${user.first_name} ${user.last_name}`.trim(), emails, avatarUrl)
    } catch {
      const last = this.plugin.settings.lastTokenValidated
      const lastStr = last ? ` · Last validated ${new Date(last).toLocaleString()}` : ''
      descEl.addClass('cv-desc-error')
      descEl.setText(`Token validation failed${lastStr}`)
    }
  }

  private openTokenModal(): void {
    new TokenModal(
      this.app,
      this.plugin.settings.apiToken,
      async (token, user) => {
        const emails = user.identities?.map(id => id.provider_email).filter((e): e is string => !!e) ?? []
        const avatarUrl = user.image_url

        this.plugin.settings.apiToken = token
        this.plugin.settings.connectedUserId = user.user_guid
        this.plugin.settings.connectedUserName = `${user.first_name} ${user.last_name}`.trim()
        this.plugin.settings.connectedUserAvatarUrl = avatarUrl
        this.plugin.settings.connectedIdentityEmails = emails
        this.plugin.settings.lastTokenValidated = new Date().toISOString()
        await this.plugin.saveSettings()
        this.channels = null
        this.channelsError = null
        this.channelsHasMore = true
        this.channelsCursorMs = null
        this.workspaces = null
        this.workspacesError = null
        this.guestWorkspaceIds = new Set()
        this.folders = null
        this.foldersError = null
        this.display()
      }
    ).open()
  }
}
