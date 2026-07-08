import { TFile, TFolder, normalizePath } from 'obsidian'
import type CarbonVoiceSyncPlugin from './main'
import { CarbonVoiceAPI } from './api'
import type {
  CarbonVoiceMessage,
  CarbonVoiceChannel,
  CarbonVoiceFolder,
  HistoryWindow,
} from './types'
import { ASYNC_MEETING_PREFIX } from './types'

export interface SyncResult {
  firstRun: boolean
  conversations: number // conversation month-files written
  voiceMemos: number // voice memo notes written
}

const PAGE = 200
const MAX_PAGES = 500 // safety cap on pagination loops

// Everything the sync writes goes above this marker; anything a user types below it is preserved
// across re-syncs. `MARKER_KEY` is the stable substring used to locate the marker in an old file.
const MARKER_KEY = 'carbon-voice-sync:managed-above'
const USER_SECTION_MARKER = `%% ${MARKER_KEY} — Carbon Voice manages everything above this line. Notes you add below are kept across syncs. %%`

export class CarbonVoiceSync {
  constructor(private plugin: CarbonVoiceSyncPlugin) {}

  // Set when the persisted note index changes during a run, so we save once at the end.
  private indexDirty = false

  private get app() {
    return this.plugin.app
  }
  private get settings() {
    return this.plugin.settings
  }

  // ── Public entry points ─────────────────────────────────────────────────

  // Forward incremental sync. First run only sets the baseline (no historical pull).
  async syncIncremental(): Promise<SyncResult> {
    const api = new CarbonVoiceAPI(this.settings.apiToken)
    // Capture the baseline before fetching: any message updated during this run then gets
    // re-pulled next time rather than being skipped. Status changes bump last_updated_at, so
    // a message that goes `active` (transcript ready) after we saw it will resync on its own.
    const startedAt = new Date().toISOString()
    const since = this.settings.lastSyncTimestamp

    if (since == null) {
      this.settings.lastSyncTimestamp = startedAt
      await this.plugin.saveSettings()
      return { firstRun: true, conversations: 0, voiceMemos: 0 }
    }

    const messages = await this.collectMessagesSince(api, since)
    const memos = messages.filter(m => this.isVoiceMemo(m) && this.memoInScope(m))
    const convMsgs = await this.selectConversationMessages(api, messages)

    const voiceMemos = await this.processVoiceMemos(api, memos)
    const conversations = await this.processConversations(api, convMsgs)

    this.settings.lastSyncTimestamp = startedAt
    await this.plugin.saveSettings()
    return { firstRun: false, conversations, voiceMemos }
  }

  // Explicit historical pull for BOTH categories in a single fetch — the recents endpoint
  // returns everything, so fetching once and splitting avoids re-pulling and dropping messages.
  // Each category is filtered to its own window. Does not touch the incremental baseline.
  async importHistory(
    conversationWindow: HistoryWindow,
    voiceMemoWindow: HistoryWindow
  ): Promise<SyncResult> {
    const api = new CarbonVoiceAPI(this.settings.apiToken)
    const convSince = this.windowToSince(conversationWindow)
    const memoSince = this.windowToSince(voiceMemoWindow)
    // Fetch once over the larger of the two windows, then filter each category by its own.
    const earliest = convSince < memoSince ? convSince : memoSince
    const messages = await this.collectMessagesSince(api, earliest)

    const memoMsgs = messages.filter(
      m => m.created_at >= memoSince && this.isVoiceMemo(m) && this.memoInScope(m)
    )
    const voiceMemos = await this.processVoiceMemos(api, memoMsgs)

    const convCandidates = messages.filter(m => m.created_at >= convSince)
    const convMsgs = await this.selectConversationMessages(api, convCandidates)
    const conversations = await this.processConversations(api, convMsgs)

    return { firstRun: false, conversations, voiceMemos }
  }

  // ── Message fetching ────────────────────────────────────────────────────

  // All messages updated at/after `sinceIso`, paging forward by last_updated_at.
  private async collectMessagesSince(
    api: CarbonVoiceAPI,
    sinceIso: string
  ): Promise<CarbonVoiceMessage[]> {
    const out = new Map<string, CarbonVoiceMessage>()
    let cursor = sinceIso
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api.getRecentMessages({
        date: cursor,
        direction: 'newer',
        use_last_updated: true,
        limit: PAGE,
      })
      if (page.length === 0) break
      let newest = cursor
      for (const m of page) {
        out.set(m.message_id, m)
        const ts = m.last_updated_at || m.created_at
        if (ts > newest) newest = ts
      }
      if (newest === cursor || page.length < PAGE) break
      cursor = newest
    }
    return [...out.values()]
  }

  // A single channel's messages within one YYYY-MM month, paging older from the month end.
  private async fetchChannelMonth(
    api: CarbonVoiceAPI,
    channelGuid: string,
    monthKey: string
  ): Promise<CarbonVoiceMessage[]> {
    const { start, end } = monthBounds(monthKey)
    const out = new Map<string, CarbonVoiceMessage>()
    let cursor = end
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api.getRecentMessages({
        channel_id: channelGuid,
        date: cursor,
        direction: 'older',
        use_last_updated: false,
        limit: PAGE,
      })
      if (page.length === 0) break
      let oldest = cursor
      for (const m of page) {
        if (m.created_at >= start && m.created_at < end) out.set(m.message_id, m)
        if (m.created_at < oldest) oldest = m.created_at
      }
      if (oldest < start || oldest === cursor || page.length < PAGE) break
      cursor = oldest
    }
    return [...out.values()]
  }

  // ── Voice memos ─────────────────────────────────────────────────────────

  private async processVoiceMemos(
    api: CarbonVoiceAPI,
    memos: CarbonVoiceMessage[]
  ): Promise<number> {
    // Drop notes for memos deleted since last sync (they resurface here with `deleted_at` set).
    for (const m of memos.filter(m => m.deleted_at)) await this.removeNote(`memo:${m.message_id}`)

    const live = memos.filter(m => !m.deleted_at && !isPending(m))
    if (live.length === 0) {
      await this.flushIndex()
      return 0
    }

    const folders = await this.fetchFolders(api)
    const workspaces = await this.fetchWorkspaceNames(api)

    let count = 0
    for (const m of live) {
      const transcript = messageTranscript(m)
      const summary = extractText(m, 'summary')
      const subpath = this.memoSubpath(m, folders, workspaces)
      const title = memoTitle(m, summary, transcript)
      const wsName = (m.workspace_ids[0] && workspaces.get(m.workspace_ids[0])) || ''
      // Voice memos are authored by the connected account; link that person when we know them.
      const creatorName =
        m.creator_id === this.settings.connectedUserId ? this.settings.connectedUserName || '' : ''
      if (this.settings.linkNotes) {
        if (wsName) await this.ensureWorkspaceNote(wsName)
        if (creatorName) await this.ensurePersonNote(creatorName)
      }
      const audioPath =
        this.settings.audioMode === 'download' ? await this.ensureAudio(api, m) : null
      const path = `${this.root()}/Voice Memos/${subpath}/${sanitize(title)}.md`
      await this.upsertFile(
        path,
        this.buildVoiceMemoNote(m, subpath, title, transcript, summary, wsName, creatorName, audioPath)
      )
      await this.recordNote(`memo:${m.message_id}`, path)
      count++
    }
    await this.flushIndex()
    return count
  }

  private memoSubpath(
    m: CarbonVoiceMessage,
    folders: Map<string, CarbonVoiceFolder>,
    workspaces: Map<string, string>
  ): string {
    // Workspace-first so identical folder names in different workspaces never collide.
    const ws = m.workspace_ids[0]
    const wsName = sanitize((ws && workspaces.get(ws)) || 'Unfiled')
    if (m.folder_id && folders.has(m.folder_id)) {
      const f = folders.get(m.folder_id)!
      const names = [...(f.path ?? [])].reverse().map(id => folders.get(id)?.name ?? '…')
      const folderPath = [...names, f.name].map(sanitize).join('/')
      return `${wsName}/${folderPath}`
    }
    return wsName
  }

  private buildVoiceMemoNote(
    m: CarbonVoiceMessage,
    subpath: string,
    title: string,
    transcript: string | null,
    summary: string | null,
    wsName: string,
    creatorName: string,
    audioPath: string | null
  ): string {
    const link = this.settings.linkNotes
    const durationSec = Math.round((m.duration_ms ?? 0) / 1000)
    const memoUrl = `https://carbonvoice.app/m/${m.message_id}`
    const fm = [
      '---',
      `cv_memo_id: ${m.message_id}`,
      `memo_link: ${memoUrl}`,
      `cv_folder: ${yaml(subpath)}`,
      `title: ${yaml(title)}`,
      `date: ${m.created_at.slice(0, 10)}`,
      `duration: ${durationSec}`,
    ]
    if (link && wsName) fm.push(`workspace: ${yaml(this.workspaceLink(wsName))}`)
    if (link && creatorName) fm.push(`person: ${yaml(this.personLink(creatorName))}`)
    fm.push('tags: [carbon-voice, voice-memo]', '---', '')

    const body: string[] = [`# ${title}`, '']
    if (summary) body.push('## Summary', summary, '')
    if (this.settings.includeTranscripts) {
      body.push('## Transcript', transcript || '> No transcript available yet.', '')
    }
    body.push(...this.audioBlock(m, memoUrl, audioPath))
    body.push(...this.attachmentsBlock(m))

    body.push('## Metadata')
    if (link && creatorName) body.push(`- **From:** ${this.personLink(creatorName)}`)
    if (link && wsName) body.push(`- **Workspace:** ${this.workspaceLink(wsName)}`)
    const datePrefix = link ? `[[${m.created_at.slice(0, 10)}]] · ` : ''
    body.push(
      `- **Date:** ${datePrefix}${formatDateTime(m.created_at)}`,
      `- **Duration:** ${durationSec}s`,
      `- **Synced:** ${formatDateTime(new Date().toISOString())}`,
      `- [Open in Carbon Voice ↗](${memoUrl})`,
      ''
    )
    return fm.concat(body).join('\n')
  }

  // ── Conversations ───────────────────────────────────────────────────────

  private async processConversations(
    api: CarbonVoiceAPI,
    convMsgs: CarbonVoiceMessage[]
  ): Promise<number> {
    // Which (channel, month) files were touched? Include deleted messages so a month that lost
    // its last message is revisited and its now-empty file removed.
    const touched = new Map<string, Set<string>>()
    for (const m of convMsgs.filter(m => !isPending(m))) {
      const month = m.created_at.slice(0, 7)
      for (const ch of m.channel_ids) {
        if (!touched.has(ch)) touched.set(ch, new Set())
        touched.get(ch)!.add(month)
      }
    }

    let count = 0
    const channelCache = new Map<string, CarbonVoiceChannel>()
    for (const [ch, months] of touched) {
      let channel = channelCache.get(ch)
      if (!channel) {
        channel = await api.getChannel(ch)
        channelCache.set(ch, channel)
      }
      for (const month of months) {
        const key = `conv:${ch}:${month}`
        const msgs = (await this.fetchChannelMonth(api, ch, month)).filter(
          m => !m.deleted_at && !isPending(m)
        )
        if (msgs.length === 0) {
          // Every message in this month is gone — remove the file we previously wrote for it.
          await this.removeNote(key)
          continue
        }
        if (this.settings.linkNotes) await this.ensureEntityNotes(channel)
        msgs.sort((a, b) => a.created_at.localeCompare(b.created_at))
        const audioPaths =
          this.settings.audioMode === 'download'
            ? await this.collectAudio(api, msgs)
            : new Map<string, string>()
        const path = `${this.root()}/Conversations/${sanitize(workspaceName(channel))}/${sanitize(channelName(channel))}/${month} Messages.md`
        await this.upsertFile(path, this.buildConversationNote(channel, month, msgs, audioPaths))
        await this.recordNote(key, path)
        count++
      }
    }
    await this.flushIndex()
    return count
  }

  private buildConversationNote(
    channel: CarbonVoiceChannel,
    monthKey: string,
    messages: CarbonVoiceMessage[],
    audioPaths: Map<string, string>
  ): string {
    const link = this.settings.linkNotes
    const nameById = new Map<string, string>()
    for (const c of channel.json_collaborators ?? []) {
      nameById.set(c.user_guid, `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.user_guid)
    }
    const participants = [...nameById.values()]
    const title = channelName(channel)
    const wsName = channel.workspace_name ?? ''
    const participantsFm = participants.map(p => (link ? this.personLink(p) : p))

    const fm = [
      '---',
      `cv_conversation_id: ${channel.channel_guid}`,
      `conversation_link: https://carbonvoice.app/c/${channel.channel_guid}`,
      `conversation_name: ${yaml(title)}`,
      `workspace_name: ${yaml(wsName)}`,
      `workspace_id: ${channel.workspace_guid}`,
    ]
    if (link && wsName) fm.push(`workspace: ${yaml(this.workspaceLink(wsName))}`)
    fm.push(
      `month: ${monthKey}`,
      `participants: [${participantsFm.map(yaml).join(', ')}]`,
      'tags: [carbon-voice]',
      '---',
      ''
    )
    const body: string[] = [`# ${title} — ${formatMonth(monthKey)}`, '']

    // Conversation context: the channel's own description, shown as an Obsidian callout.
    const about = channel.channel_description?.trim()
    if (about) body.push('> [!info] About', ...about.split('\n').map(l => `> ${l}`), '')

    // Summary digest: one line per message that carries an AI summary — a skim of the month.
    const digest = messages
      .map(m => ({ who: nameById.get(m.creator_id) || 'Unknown', s: extractText(m, 'summary') }))
      .filter((d): d is { who: string; s: string } => !!d.s)
    if (digest.length) {
      body.push('## Summary', '')
      for (const d of digest) body.push(`- **${d.who}:** ${d.s}`)
      body.push('')
    }

    if (this.settings.includeTranscripts) {
      body.push('## Messages', '')
      // Order messages as threads: each message is followed by its replies (recursively), so a
      // reply sits directly under the message it answers instead of wherever it fell in time.
      for (const { m, depth } of threadOrder(messages)) {
        const senderName = nameById.get(m.creator_id) || 'Unknown'
        const sender = link && senderName !== 'Unknown' ? this.personLink(senderName) : senderName
        const isText = m.is_text_message
        const url = `https://carbonvoice.app/m/${m.message_id}`
        const transcript = messageTranscript(m)
        // 💬 text · 🎙️ audio; time before date; duration only shown for audio messages.
        const parts = [
          `${depth > 0 ? '↳ ' : ''}${isText ? '💬' : '🎙️'} ${sender}`,
          formatTime(m.created_at),
          this.dayCell(m.created_at),
        ]
        if (!isText) parts.push(`${Math.round((m.duration_ms ?? 0) / 1000)}s`)
        body.push(`### ${parts.join(' · ')}`)
        // Reply context: name who is being answered when the parent isn't in this file.
        const parentName = m.parent_message_id ? nameById.get(parentCreator(messages, m)) : undefined
        if (depth === 0 && m.parent_message_id) {
          const parentUrl = `https://carbonvoice.app/m/${m.parent_message_id}`
          body.push(`<sub>↳ reply · <a href="${parentUrl}">see parent ↗</a></sub>`, '')
        } else if (depth > 0 && parentName) {
          body.push(`<sub>↳ in reply to ${parentName}</sub>`, '')
        }
        body.push(transcript || '_[No transcript available]_', '')
        body.push(...this.audioBlock(m, url, audioPaths.get(m.message_id) ?? null))
        body.push(...this.attachmentsBlock(m))
        body.push(`<sub><a href="${url}">Open in Carbon Voice ↗</a></sub>`, '', '---', '')
      }
    }

    body.push('## Metadata', `- **Synced:** ${formatDateTime(new Date().toISOString())}`, '')
    return fm.concat(body).join('\n')
  }

  // ── Scope predicates ─────────────────────────────────────────────────────

  private isVoiceMemo(m: CarbonVoiceMessage): boolean {
    return m.type === 'voicememo'
  }

  private isConversation(m: CarbonVoiceMessage): boolean {
    return m.type !== 'voicememo' && Array.isArray(m.channel_ids) && m.channel_ids.length > 0
  }

  // Selects the conversation messages to sync, honouring the conversation scope. For the
  // `by_conversation` scope this also resolves any "all async meetings in <workspace>" rules:
  // a rule matches every conversation whose channel type is `asyncMeeting`, including ones
  // created after the rule was set. Channel types aren't on the message, so we look them up
  // (cache-first) and remember discovered async meetings so they keep syncing.
  private async selectConversationMessages(
    api: CarbonVoiceAPI,
    messages: CarbonVoiceMessage[]
  ): Promise<CarbonVoiceMessage[]> {
    const conv = messages.filter(m => this.isConversation(m))
    const s = this.settings

    // Only the `by_conversation` scope carries async-meeting rules; every other scope is a
    // pure message-level predicate with no channel fetches needed.
    const asyncWs = this.asyncRuleWorkspaceIds()
    if (s.conversationScope !== 'by_conversation' || asyncWs.size === 0) {
      return conv.filter(m => this.convInScope(m))
    }

    // Classify the channels of any message in an async-ruled workspace that we haven't seen
    // before. One fetch per unknown channel; the result is cached across syncs.
    const cache = s.channelTypeCache
    const unknown = new Set<string>()
    for (const m of conv) {
      if (!m.workspace_ids.some(w => asyncWs.has(w))) continue
      for (const ch of m.channel_ids) if (!(ch in cache)) unknown.add(ch)
    }

    let cacheChanged = false
    for (const ch of unknown) {
      try {
        const channel = await api.getChannel(ch)
        cache[ch] = channel.type
        cacheChanged = true
      } catch {
        // Leave unclassified; a later sync retries once the message resurfaces.
      }
    }

    // Materialise newly-discovered async meetings into the selected list so they're visible in
    // settings and stay synced even if the workspace rule is later removed.
    const discovered = [...unknown].filter(
      ch => cache[ch] === 'asyncMeeting' && !s.conversationIds.includes(ch)
    )
    if (discovered.length) s.conversationIds.push(...discovered)
    if (cacheChanged || discovered.length) await this.plugin.saveSettings()

    return conv.filter(m => this.convInScope(m) || this.matchesAsyncRule(m, asyncWs))
  }

  // Workspace ids named by any `asyncmeeting:<workspace_id>` rule in the selected list.
  private asyncRuleWorkspaceIds(): Set<string> {
    const ids = new Set<string>()
    for (const token of this.settings.conversationIds) {
      if (token.startsWith(ASYNC_MEETING_PREFIX)) ids.add(token.slice(ASYNC_MEETING_PREFIX.length))
    }
    return ids
  }

  // True when a message belongs to an async-ruled workspace and its channel is (per the cache)
  // an async meeting.
  private matchesAsyncRule(m: CarbonVoiceMessage, asyncWs: Set<string>): boolean {
    if (!m.workspace_ids.some(w => asyncWs.has(w))) return false
    return m.channel_ids.some(ch => this.settings.channelTypeCache[ch] === 'asyncMeeting')
  }

  private convInScope(m: CarbonVoiceMessage): boolean {
    const s = this.settings
    switch (s.conversationScope) {
      case 'by_workspace':
        return m.workspace_ids.some(w => s.conversationWorkspaceIds.includes(w))
      case 'by_conversation':
        // Async-meeting rule tokens live in this list too; they never equal a channel GUID, so
        // this plain-membership check ignores them (matchesAsyncRule handles them separately).
        return m.channel_ids.some(c => s.conversationIds.includes(c))
      default:
        return true
    }
  }

  private memoInScope(m: CarbonVoiceMessage): boolean {
    const s = this.settings
    switch (s.voiceMemoScope) {
      case 'by_workspace':
        return m.workspace_ids.some(w => s.voiceMemoWorkspaceIds.includes(w))
      case 'by_folder':
        if (m.folder_id && s.voiceMemoFolderIds.includes(m.folder_id)) return true
        // A `root:<workspace_id>` selection matches memos with no folder in that workspace.
        if (!m.folder_id)
          return m.workspace_ids.some(w => s.voiceMemoFolderIds.includes(`root:${w}`))
        return false
      default:
        return true
    }
  }

  // ── Lookups ──────────────────────────────────────────────────────────────

  private async fetchFolders(api: CarbonVoiceAPI): Promise<Map<string, CarbonVoiceFolder>> {
    const roots = await api.getFolders({ type: 'voicememo', include_all_tree: true })
    const map = new Map<string, CarbonVoiceFolder>()
    const walk = (f: CarbonVoiceFolder) => {
      if (map.has(f.id)) return
      map.set(f.id, f)
      f.subfolders?.forEach(walk)
    }
    roots.forEach(walk)
    return map
  }

  private async fetchWorkspaceNames(api: CarbonVoiceAPI): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    let cursor: string | null = null
    for (let i = 0; i < 50; i++) {
      const res = await api.getWorkspaces({
        limit: 100,
        ...(cursor ? { starting_after: cursor } : {}),
      })
      for (const w of res.results) map.set(w.id, w.name)
      if (!res.has_more || !res.next_cursor || res.next_cursor === cursor) break
      cursor = res.next_cursor
    }
    return map
  }

  // ── Vault helpers ─────────────────────────────────────────────────────────

  private root(): string {
    return this.settings.syncFolder.trim() || 'Carbon Voice'
  }

  private windowToSince(window: HistoryWindow): string {
    if (window === 'all') return '1970-01-01T00:00:00.000Z'
    return new Date(Date.now() - window * 24 * 60 * 60 * 1000).toISOString()
  }

  // Writes a managed note. The generated content is placed above a marker line; whatever the user
  // has written below the marker in an existing file is carried over verbatim, so re-syncs never
  // clobber annotations. New files get an empty area below the marker to write in.
  private async upsertFile(rawPath: string, generated: string): Promise<void> {
    const path = normalizePath(rawPath)
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, data =>
        this.wrapManaged(generated, this.preservedTail(data))
      )
      return
    }
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) await this.ensureFolder(dir)
    await this.app.vault.create(path, this.wrapManaged(generated, ''))
  }

  private wrapManaged(generated: string, preserved: string): string {
    const base = generated.endsWith('\n') ? generated : `${generated}\n`
    // A leading newline gives new files a blank line to type on under the marker.
    return `${base}\n${USER_SECTION_MARKER}\n${preserved || '\n'}`
  }

  // Content after the managed marker in an existing file (the user-owned region). Empty when the
  // file predates the marker or has none — those files are simply re-wrapped on this sync.
  private preservedTail(content: string): string {
    const idx = content.indexOf(MARKER_KEY)
    if (idx === -1) return ''
    const nl = content.indexOf('\n', idx)
    return nl === -1 ? '' : content.slice(nl + 1)
  }

  // ── Note index (rename / delete reconciliation) ────────────────────────────

  // Record that `key` now lives at `path`. If it previously lived elsewhere (e.g. the conversation
  // or memo was renamed), the stale file is removed and its empty folders pruned.
  private async recordNote(key: string, path: string): Promise<void> {
    const prev = this.settings.noteIndex[key]
    const norm = normalizePath(path)
    if (prev && normalizePath(prev) !== norm) await this.deleteFileAndPrune(prev)
    if (prev !== norm) {
      this.settings.noteIndex[key] = norm
      this.indexDirty = true
    }
  }

  // Remove the note previously written for `key` (its source was deleted or the month emptied).
  private async removeNote(key: string): Promise<void> {
    const prev = this.settings.noteIndex[key]
    if (!prev) return
    await this.deleteFileAndPrune(prev)
    delete this.settings.noteIndex[key]
    this.indexDirty = true
  }

  // Trashes a note (recoverable, not hard-deleted) and prunes now-empty ancestor folders up to,
  // but not including, the sync root.
  private async deleteFileAndPrune(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath)
    const file = this.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) {
      try {
        await this.app.vault.trash(file, false)
      } catch {
        return
      }
    }
    const rootPath = normalizePath(this.root())
    let dir = path.split('/').slice(0, -1).join('/')
    while (dir && dir !== rootPath && dir.startsWith(`${rootPath}/`)) {
      const folder = this.app.vault.getAbstractFileByPath(dir)
      if (folder instanceof TFolder && folder.children.length === 0) {
        try {
          await this.app.vault.trash(folder, false)
        } catch {
          break
        }
        dir = dir.split('/').slice(0, -1).join('/')
      } else break
    }
  }

  private async flushIndex(): Promise<void> {
    if (!this.indexDirty) return
    this.indexDirty = false
    await this.plugin.saveSettings()
  }

  private async ensureFolder(dir: string): Promise<void> {
    const parts = normalizePath(dir).split('/')
    let cur = ''
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur)
        } catch {
          // Ignore races / already-exists.
        }
      }
    }
  }

  // Creates a file only if it doesn't already exist — never overwrites. Used for People/Workspace
  // stub notes so users can freely annotate them without a later sync clobbering their edits.
  private async createIfAbsent(rawPath: string, content: string): Promise<void> {
    const path = normalizePath(rawPath)
    if (this.app.vault.getAbstractFileByPath(path)) return
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) await this.ensureFolder(dir)
    try {
      await this.app.vault.create(path, content)
    } catch {
      // Ignore races / already-exists.
    }
  }

  // ── Entity notes & links ──────────────────────────────────────────────────

  // Wiki-link to a person/workspace note, addressed by full vault path so it resolves regardless
  // of same-named notes elsewhere in the vault. `sanitize` matches the note's on-disk filename.
  private personLink(name: string): string {
    return `[[${this.root()}/People/${sanitize(name)}|${name}]]`
  }
  private workspaceLink(name: string): string {
    return `[[${this.root()}/Workspaces/${sanitize(name)}|${name}]]`
  }

  private async ensureEntityNotes(channel: CarbonVoiceChannel): Promise<void> {
    const ws = channel.workspace_name?.trim()
    if (ws) await this.ensureWorkspaceNote(ws)
    for (const c of channel.json_collaborators ?? []) {
      const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.user_guid
      await this.ensurePersonNote(name)
    }
  }

  private async ensurePersonNote(name: string): Promise<void> {
    const path = `${this.root()}/People/${sanitize(name)}.md`
    await this.createIfAbsent(
      path,
      [
        '---',
        `title: ${yaml(name)}`,
        'tags: [carbon-voice, person]',
        '---',
        '',
        `# ${name}`,
        '',
        '> Auto-created by Carbon Voice Sync. The backlinks pane lists every conversation and',
        '> voice memo this person appears in.',
        '',
      ].join('\n')
    )
  }

  private async ensureWorkspaceNote(name: string): Promise<void> {
    const path = `${this.root()}/Workspaces/${sanitize(name)}.md`
    await this.createIfAbsent(
      path,
      [
        '---',
        `title: ${yaml(name)}`,
        'tags: [carbon-voice, workspace]',
        '---',
        '',
        `# ${name}`,
        '',
        '> Auto-created by Carbon Voice Sync. The backlinks pane lists every conversation and',
        '> voice memo in this workspace.',
        '',
      ].join('\n')
    )
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  // The audio player block for one message, per the active audio mode. Returns lines to splice
  // into the note body (empty for text messages, mode 'off', or a missing download).
  private audioBlock(
    m: CarbonVoiceMessage,
    messageUrl: string,
    downloadedPath: string | null
  ): string[] {
    if (m.is_text_message) return []
    switch (this.settings.audioMode) {
      case 'embed':
        // The message URL is oEmbed-aware and renders the Carbon Voice player in an iframe;
        // non-public messages show their own locked state, so no visibility check is needed.
        return [
          `<iframe src="${messageUrl}" width="100%" height="180" frameborder="0" allow="autoplay; encrypted-media" loading="lazy"></iframe>`,
          '',
        ]
      case 'download':
        return downloadedPath ? [`![[${downloadedPath}]]`, ''] : []
      default:
        return []
    }
  }

  // Attachment list for a message (files shared alongside it). Empty when there are none.
  private attachmentsBlock(m: CarbonVoiceMessage): string[] {
    const atts = m.attachments ?? []
    if (!atts.length) return []
    const lines = ['**Attachments:**']
    for (const a of atts) {
      const label = a.filename?.trim() || a.type || 'file'
      lines.push(a.link ? `- 📎 [${label}](${a.link})` : `- 📎 ${label}`)
    }
    lines.push('')
    return lines
  }

  // A day as a `[[YYYY-MM-DD]]` daily-note link (when linking is on) or plain text otherwise.
  private dayCell(iso: string): string {
    const d = iso.slice(0, 10)
    return this.settings.linkNotes ? `[[${d}|${formatDayShort(iso)}]]` : formatDayShort(iso)
  }

  private async collectAudio(
    api: CarbonVoiceAPI,
    msgs: CarbonVoiceMessage[]
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    for (const m of msgs) {
      const p = await this.ensureAudio(api, m)
      if (p) map.set(m.message_id, p)
    }
    return map
  }

  // Ensures a local copy of a message's audio exists, returning its vault path (or null for text /
  // undownloadable messages). Audio is immutable, so an existing file is reused — never re-fetched.
  private async ensureAudio(api: CarbonVoiceAPI, m: CarbonVoiceMessage): Promise<string | null> {
    if (m.is_text_message) return null
    const path = `${this.root()}/Media/${m.message_id}.mp3`
    const norm = normalizePath(path)
    if (this.app.vault.getAbstractFileByPath(norm)) return path
    const buf = await this.fetchAudioBuffer(api, m)
    if (!buf) return null
    await this.ensureFolder(`${this.root()}/Media`)
    try {
      await this.app.vault.createBinary(norm, buf)
      return path
    } catch {
      // A concurrent sync may have written it first; the embed still resolves if it now exists.
      return this.app.vault.getAbstractFileByPath(norm) ? path : null
    }
  }

  // Tries the audio URL already in the message payload first; if that fails (e.g. its presigned
  // URL has expired), fetches a fresh presigned URL via the v5 message endpoint.
  private async fetchAudioBuffer(
    api: CarbonVoiceAPI,
    m: CarbonVoiceMessage
  ): Promise<ArrayBuffer | null> {
    const direct = m.audio_models?.find(a => a.is_original_audio)?.url ?? m.audio_models?.[0]?.url
    if (direct) {
      try {
        return await api.downloadBinary(direct)
      } catch {
        // Fall through to a freshly-signed URL.
      }
    }
    try {
      const v5 = await api.getMessage(m.message_id, { presigned_url: true, fresh: true })
      const url = v5.audio?.presigned_url ?? v5.audio?.url ?? null
      if (url) return await api.downloadBinary(url)
    } catch {
      // Give up quietly; the note still links out to Carbon Voice.
    }
    return null
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

// Orders messages so each appears immediately before its replies (depth-first). Replies whose
// parent isn't in this set are treated as roots; siblings keep chronological order. A seen-set
// guards against parent cycles and guarantees every message is emitted exactly once.
function threadOrder(
  messages: CarbonVoiceMessage[]
): Array<{ m: CarbonVoiceMessage; depth: number }> {
  const byId = new Map(messages.map(m => [m.message_id, m]))
  const children = new Map<string, CarbonVoiceMessage[]>()
  const roots: CarbonVoiceMessage[] = []
  for (const m of messages) {
    const parent = m.parent_message_id && byId.has(m.parent_message_id) ? m.parent_message_id : null
    if (parent) {
      const arr = children.get(parent) ?? []
      arr.push(m)
      children.set(parent, arr)
    } else {
      roots.push(m)
    }
  }
  const byCreated = (a: CarbonVoiceMessage, b: CarbonVoiceMessage) =>
    a.created_at.localeCompare(b.created_at)
  const out: Array<{ m: CarbonVoiceMessage; depth: number }> = []
  const seen = new Set<string>()
  const visit = (m: CarbonVoiceMessage, depth: number) => {
    if (seen.has(m.message_id)) return
    seen.add(m.message_id)
    out.push({ m, depth })
    for (const kid of (children.get(m.message_id) ?? []).sort(byCreated)) visit(kid, depth + 1)
  }
  roots.sort(byCreated).forEach(r => visit(r, 0))
  // Any message left unseen (part of a cycle) is appended so nothing is dropped.
  for (const m of messages) if (!seen.has(m.message_id)) out.push({ m, depth: 0 })
  return out
}

// creator_id of a message's parent, when the parent is in this set (else '').
function parentCreator(messages: CarbonVoiceMessage[], m: CarbonVoiceMessage): string {
  if (!m.parent_message_id) return ''
  return messages.find(x => x.message_id === m.parent_message_id)?.creator_id ?? ''
}

function channelName(c: CarbonVoiceChannel): string {
  return c.channel_name?.trim() || `Conversation ${c.channel_guid.slice(0, 8)}`
}

function workspaceName(c: CarbonVoiceChannel): string {
  return c.workspace_name?.trim() || 'Unfiled'
}

function extractText(m: CarbonVoiceMessage, type: string): string | null {
  const model = m.text_models?.find(t => t.type === type)
  return model?.value?.trim() || null
}

// Transcript from the recent-list payload. Text messages carry it in `value`; audio messages
// use a `transcript_with_timecode` model whose `value` is empty — the words are in `timecodes`.
function messageTranscript(m: CarbonVoiceMessage): string | null {
  for (const type of ['transcript', 'transcript_with_timecode']) {
    const model = m.text_models?.find(t => t.type === type)
    if (!model) continue
    const value = model.value?.trim()
    if (value) return value
    if (model.timecodes?.length) {
      const joined = model.timecodes
        .map(tc => tc.t)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (joined) return joined
    }
  }
  return null
}

// A message still processing (e.g. transcription pending) isn't `active` yet. We skip it and
// let it resync once it goes active — status changes bump last_updated_at, so it comes back.
function isPending(m: CarbonVoiceMessage): boolean {
  return m.status != null && m.status !== 'active'
}

// Title for a voice memo note: explicit name, else AI summary, else a truncated transcript,
// else a dated fallback. Summary/transcript keep memos individually identifiable.
function memoTitle(
  m: CarbonVoiceMessage,
  summary: string | null,
  transcript: string | null
): string {
  const date = m.created_at.slice(0, 10)
  const label = m.name?.trim() || summary || transcript || 'Voice Memo'
  return `${date}: ${truncateTitle(label)}`
}

function truncateTitle(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  const cut = oneLine.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

// Illegal/awkward characters for vault paths and wiki-links.
function sanitize(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned || 'Untitled'
}

// Minimal YAML string escaping for frontmatter scalar values.
function yaml(value: string): string {
  if (/[:#\[\]{}",&*!|>'%@`]/.test(value) || value.trim() !== value) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return value
}

function monthBounds(monthKey: string): { start: string; end: string } {
  const [y, m] = monthKey.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1))
  return { start: start.toISOString(), end: end.toISOString() }
}

function formatMonth(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function formatDayShort(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric' })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
