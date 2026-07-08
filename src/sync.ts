import { TFile, normalizePath } from 'obsidian'
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

export class CarbonVoiceSync {
  constructor(private plugin: CarbonVoiceSyncPlugin) {}

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
    const live = memos.filter(m => !m.deleted_at && !isPending(m))
    if (live.length === 0) return 0

    const folders = await this.fetchFolders(api)
    const workspaces = await this.fetchWorkspaceNames(api)

    let count = 0
    for (const m of live) {
      const transcript = messageTranscript(m)
      const summary = extractText(m, 'summary')
      const subpath = this.memoSubpath(m, folders, workspaces)
      const title = memoTitle(m, summary, transcript)
      const path = `${this.root()}/Voice Memos/${subpath}/${sanitize(title)}.md`
      await this.upsertFile(path, this.buildVoiceMemoNote(m, subpath, title, transcript))
      count++
    }
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
    transcript: string | null
  ): string {
    const durationSec = Math.round((m.duration_ms ?? 0) / 1000)
    const fm = [
      '---',
      `cv_memo_id: ${m.message_id}`,
      `cv_folder: ${yaml(subpath)}`,
      `title: ${yaml(title)}`,
      `date: ${m.created_at.slice(0, 10)}`,
      `duration: ${durationSec}`,
      'tags: [carbon-voice, voice-memo]',
      '---',
      '',
    ]
    const body: string[] = [`# ${title}`, '']
    if (this.settings.includeTranscripts) {
      body.push('## Transcript', transcript || '> No transcript available yet.', '')
    }
    body.push(
      '## Metadata',
      `- **Date:** ${formatDateTime(m.created_at)}`,
      `- **Duration:** ${durationSec}s`,
      `- **Synced:** ${formatDateTime(new Date().toISOString())}`,
      ''
    )
    return fm.concat(body).join('\n')
  }

  // ── Conversations ───────────────────────────────────────────────────────

  private async processConversations(
    api: CarbonVoiceAPI,
    convMsgs: CarbonVoiceMessage[]
  ): Promise<number> {
    const live = convMsgs.filter(m => !m.deleted_at && !isPending(m))
    // Which (channel, month) files were touched?
    const touched = new Map<string, Set<string>>()
    for (const m of live) {
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
        const msgs = (await this.fetchChannelMonth(api, ch, month)).filter(
          m => !m.deleted_at && !isPending(m)
        )
        if (msgs.length === 0) continue
        msgs.sort((a, b) => a.created_at.localeCompare(b.created_at))
        const path = `${this.root()}/Conversations/${sanitize(workspaceName(channel))}/${sanitize(channelName(channel))}/${month} Messages.md`
        await this.upsertFile(path, this.buildConversationNote(channel, month, msgs))
        count++
      }
    }
    return count
  }

  private buildConversationNote(
    channel: CarbonVoiceChannel,
    monthKey: string,
    messages: CarbonVoiceMessage[]
  ): string {
    const nameById = new Map<string, string>()
    for (const c of channel.json_collaborators ?? []) {
      nameById.set(c.user_guid, `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.user_guid)
    }
    const participants = [...nameById.values()]
    const title = channelName(channel)

    const fm = [
      '---',
      `cv_conversation_id: ${channel.channel_guid}`,
      `conversation_link: https://carbonvoice.app/c/${channel.channel_guid}`,
      `conversation_name: ${yaml(title)}`,
      `workspace_name: ${yaml(channel.workspace_name ?? '')}`,
      `workspace_id: ${channel.workspace_guid}`,
      `month: ${monthKey}`,
      `participants: [${participants.map(yaml).join(', ')}]`,
      'tags: [carbon-voice]',
      '---',
      '',
    ]
    const body: string[] = [`# ${title} — ${formatMonth(monthKey)}`, '']

    if (this.settings.includeTranscripts) {
      body.push('## Messages', '')
      for (const m of messages) {
        const sender = nameById.get(m.creator_id) || 'Unknown'
        const isText = m.is_text_message
        const url = `https://carbonvoice.app/m/${m.message_id}`
        const transcript = messageTranscript(m)
        // 💬 text · 🎙️ audio; time before date; duration only shown for audio messages.
        const parts = [
          `${isText ? '💬' : '🎙️'} ${sender}`,
          formatTime(m.created_at),
          formatDayShort(m.created_at),
        ]
        if (!isText) parts.push(`${Math.round((m.duration_ms ?? 0) / 1000)}s`)
        body.push(
          `### ${parts.join(' · ')}`,
          transcript || '_[No transcript available]_',
          '',
          `<sub><a href="${url}">Open in Carbon Voice ↗</a></sub>`,
          '',
          '---',
          ''
        )
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

  private async upsertFile(rawPath: string, content: string): Promise<void> {
    const path = normalizePath(rawPath)
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content)
      return
    }
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) await this.ensureFolder(dir)
    await this.app.vault.create(path, content)
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
}

// ── Pure helpers ────────────────────────────────────────────────────────────

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
