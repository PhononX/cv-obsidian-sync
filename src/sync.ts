import { TFile, TFolder, normalizePath } from 'obsidian'
import type CarbonVoiceSyncPlugin from './main'
import { CarbonVoiceAPI } from './api'
import type {
  CarbonVoiceMessage,
  CarbonVoiceChannel,
  CarbonVoiceFolder,
  CarbonVoiceAiResponse,
  HistoryWindow,
  MessageGrouping,
} from './types'
import { ASYNC_MEETING_PREFIX } from './types'
import { formatTranscript } from './transcript-format'

// One AI response rendered for a note: the prompt that produced it (used as a heading) and its
// body as Markdown. Built by fetchAiResponses from a message's ai_response_ids.
interface RenderedAiResponse {
  promptName: string
  body: string
}

export interface SyncResult {
  firstRun: boolean
  conversations: number // conversation month-files written
  voiceMemos: number // voice memo notes written
}

// Live progress reported to the caller so a toast can show work as it happens. `fetching` covers
// the message pull (only `fetched` is meaningful then); `writing` covers note creation, where the
// running `conversations` / `voiceMemos` counts climb as files are saved.
export interface SyncProgress {
  phase: 'fetching' | 'writing'
  fetched: number
  conversations: number
  voiceMemos: number
}

const PAGE = 50
const MAX_PAGES = 500 // safety cap on pagination loops

// Ready-made Obsidian Bases view (core Bases plugin, 1.9+). Selects conversation notes by their
// `grouping` property (only conversation notes have it, so voice memos are excluded), groups by
// `date`, and sorts newest-first — an inbox-style "by date" table over the existing notes, no
// file duplication. Written once via create-if-absent; users can refine it in the Bases GUI.
const CONVERSATIONS_BASE = `filters:
  or:
    - 'grouping == "month"'
    - 'grouping == "week"'
    - 'grouping == "day"'
views:
  - type: table
    name: Conversations by date
    groupBy:
      property: date
      direction: DESC
    order:
      - conversation
      - workspace_name
      - message_count
      - last_message_at
      - conversation_link
`

// Ready-made "All Voice Memos" Bases view, written at the sync root. Selects voice-memo
// notes by their tag and lists them newest-first with the memo's key fields. `file.name` is the
// clickable column that opens the memo note; `memo_link` is the external Carbon Voice deeplink.
const VOICE_MEMOS_BASE = `filters:
  and:
    - file.hasTag("voice-memo")
views:
  - type: table
    name: All voice memos
    order:
      - file.name
      - workspace_name
      - cv_folder
      - date
      - duration
      - summary
      - memo_link
    sort:
      - property: date
        direction: DESC
`

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
  async syncIncremental(onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
    const api = new CarbonVoiceAPI(this.settings.apiToken)
    await this.ensureBaseViews()
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

    const progress: SyncProgress = { phase: 'fetching', fetched: 0, conversations: 0, voiceMemos: 0 }
    const messages = await this.collectMessagesSince(api, since, n => {
      progress.fetched = n
      onProgress?.(progress)
    })
    progress.phase = 'writing'
    const memos = messages.filter(m => this.isVoiceMemo(m) && this.memoInScope(m))
    const convMsgs = await this.selectConversationMessages(api, messages)
    const promptNames = await this.fetchPromptNames(api)

    const voiceMemos = await this.processVoiceMemos(api, memos, promptNames, () => {
      progress.voiceMemos++
      onProgress?.(progress)
    })
    const conversations = await this.processConversations(api, convMsgs, promptNames, () => {
      progress.conversations++
      onProgress?.(progress)
    })

    this.settings.lastSyncTimestamp = startedAt
    await this.plugin.saveSettings()
    return { firstRun: false, conversations, voiceMemos }
  }

  // Explicit historical pull for BOTH categories in a single fetch — the recents endpoint
  // returns everything, so fetching once and splitting avoids re-pulling and dropping messages.
  // Each category is filtered to its own window. Does not touch the incremental baseline.
  async importHistory(
    conversationWindow: HistoryWindow,
    voiceMemoWindow: HistoryWindow,
    onProgress?: (p: SyncProgress) => void
  ): Promise<SyncResult> {
    const api = new CarbonVoiceAPI(this.settings.apiToken)
    await this.ensureBaseViews()
    const convSince = this.windowToSince(conversationWindow)
    const memoSince = this.windowToSince(voiceMemoWindow)
    // Fetch once over the larger of the two windows, then filter each category by its own.
    const earliest = convSince < memoSince ? convSince : memoSince
    const progress: SyncProgress = { phase: 'fetching', fetched: 0, conversations: 0, voiceMemos: 0 }
    const messages = await this.collectMessagesSince(api, earliest, n => {
      progress.fetched = n
      onProgress?.(progress)
    })
    progress.phase = 'writing'
    const promptNames = await this.fetchPromptNames(api)

    const memoMsgs = messages.filter(
      m => m.created_at >= memoSince && this.isVoiceMemo(m) && this.memoInScope(m)
    )
    const voiceMemos = await this.processVoiceMemos(api, memoMsgs, promptNames, () => {
      progress.voiceMemos++
      onProgress?.(progress)
    })

    const convCandidates = messages.filter(m => m.created_at >= convSince)
    const convMsgs = await this.selectConversationMessages(api, convCandidates)
    const conversations = await this.processConversations(api, convMsgs, promptNames, () => {
      progress.conversations++
      onProgress?.(progress)
    })

    return { firstRun: false, conversations, voiceMemos }
  }

  // ── Message fetching ────────────────────────────────────────────────────

  // All messages updated at/after `sinceIso`, paging forward by last_updated_at.
  private async collectMessagesSince(
    api: CarbonVoiceAPI,
    sinceIso: string,
    onFetch?: (total: number) => void
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
      onFetch?.(out.size)
      // Advance by the newest timestamp seen and keep paging. A short page (fewer than PAGE rows)
      // is NOT end-of-data — /v3/messages/recent caps its page size below our requested limit, so
      // stopping on a short page would drop everything past the first page (the oldest slice for a
      // `newer` scan), which is exactly what made a larger history window return fewer memos. Stop
      // only when a page is empty or the cursor can't move forward.
      if (newest === cursor) break
      cursor = newest
    }
    return [...out.values()]
  }

  // A single channel's messages within one grouping period (month / week / day), paging older
  // from the period end.
  private async fetchChannelPeriod(
    api: CarbonVoiceAPI,
    channelGuid: string,
    periodKey: string,
    grouping: MessageGrouping
  ): Promise<CarbonVoiceMessage[]> {
    const { start, end } = periodBounds(periodKey, grouping)
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
      // Stop once we've paged past the period start or the cursor can't move older. A short page
      // (fewer than PAGE rows) is NOT end-of-data — the endpoint caps page size below our requested
      // limit — so we keep paging until a real terminator trips instead of dropping older messages.
      if (oldest < start || oldest === cursor) break
      cursor = oldest
    }
    return [...out.values()]
  }

  // ── Voice memos ─────────────────────────────────────────────────────────

  private async processVoiceMemos(
    api: CarbonVoiceAPI,
    memos: CarbonVoiceMessage[],
    promptNames: Map<string, string>,
    onTick?: () => void
  ): Promise<number> {
    const live = memos.filter(m => !m.deleted_at && !isPending(m))
    if (live.length === 0) return 0

    const folders = await this.fetchFolders(api)
    const workspaces = await this.fetchWorkspaceNames(api)

    let count = 0
    // Tracks the note path each memo claimed this run, so two same-titled memos in one import
    // don't fight over one file — the second is disambiguated instead of overwriting the first.
    const claimed = new Map<string, string>()
    // Dedupes /responses fetches across memos that share an AI response.
    const aiCache = new Map<string, RenderedAiResponse | null>()
    for (const m of live) {
      const transcript = messageTranscript(m)
      const summary = extractText(m, 'summary')
      const subpath = this.memoSubpath(m, folders, workspaces)
      const title = memoTitle(m, summary, transcript)
      const wsName = (m.workspace_ids[0] && workspaces.get(m.workspace_ids[0])) || ''
      // Voice memos are authored by the connected account; link that person when we know them.
      const creatorName =
        m.creator_id === this.settings.connectedUserId ? this.settings.connectedUserName || '' : ''
      if (this.settings.linkNotes && creatorName) {
        await this.ensurePersonNote(creatorName)
      }
      const audioPath =
        this.settings.audioMode === 'download' ? await this.ensureAudio(api, m) : null
      const aiResponses = await this.fetchAiResponses(api, m, promptNames, aiCache)
      const basePath = `${this.root()}/Voice Memos/${subpath}/${sanitize(title)}.md`
      const path = await this.resolveMemoNotePath(basePath, m, claimed)
      await this.upsertFile(
        path,
        this.buildVoiceMemoNote(
          m, subpath, title, transcript, summary, wsName, creatorName, audioPath, aiResponses
        )
      )
      count++
      onTick?.()
    }
    return count
  }

  // Picks the on-disk note path for a memo. A memo keeps its clean title-based filename unless a
  // *different* memo already owns that path (on disk from a past sync, or claimed earlier this
  // run) — then a short message-id tag is appended so neither memo silently overwrites the other.
  // The note's displayed title (frontmatter/H1) is unchanged; only the filename carries the tag.
  // Identity is the memo id in frontmatter, so re-syncing the same memo reuses its file in place.
  private async resolveMemoNotePath(
    basePath: string,
    m: CarbonVoiceMessage,
    claimed: Map<string, string>
  ): Promise<string> {
    const base = normalizePath(basePath)
    const owner = claimed.get(base) ?? (await this.memoIdAt(base))
    let chosen = base
    if (owner != null && owner !== m.message_id) {
      const short = m.message_id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || m.message_id
      chosen = normalizePath(base.replace(/\.md$/i, ` (${short}).md`))
      // Astronomically unlikely, but if that tagged slot is taken by yet another memo, fall back
      // to the full id — guaranteed unique.
      const tagOwner = claimed.get(chosen) ?? (await this.memoIdAt(chosen))
      if (tagOwner != null && tagOwner !== m.message_id) {
        chosen = normalizePath(base.replace(/\.md$/i, ` (${m.message_id}).md`))
      }
    }
    claimed.set(chosen, m.message_id)
    return chosen
  }

  // The Carbon Voice memo id recorded in a note's frontmatter, or null if no note (or no id) lives
  // at `path`. Uses the metadata cache when warm and only reads the file when it isn't — which
  // happens at most on a genuine path collision, never on the common new-file / same-memo path.
  private async memoIdAt(path: string): Promise<string | null> {
    const f = this.app.vault.getAbstractFileByPath(path)
    if (!(f instanceof TFile)) return null
    const cached: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.cv_memo_id
    if (typeof cached === 'string') return cached
    const match = (await this.app.vault.read(f)).match(/^cv_memo_id:\s*(\S+)/m)
    return match ? match[1] : null
  }

  // Picks the folder for a channel's month notes. A channel keeps its clean name-based folder
  // unless a *different* channel already owns it (on disk from a past sync, or claimed earlier
  // this run) — then a short channel-guid tag is appended. Identity is cv_conversation_id in the
  // month notes, so re-syncing the same channel reuses its folder in place.
  private async resolveChannelFolder(
    channel: CarbonVoiceChannel,
    claimed: Map<string, string>
  ): Promise<string> {
    const base = normalizePath(
      `${this.root()}/Conversations/${sanitize(workspaceName(channel))}/${sanitize(channelName(channel))}`
    )
    const owner = claimed.get(base) ?? (await this.channelIdAt(base))
    let chosen = base
    if (owner != null && owner !== channel.channel_guid) {
      chosen = normalizePath(`${base} (${channel.channel_guid.slice(0, 8)})`)
    }
    claimed.set(chosen, channel.channel_guid)
    return chosen
  }

  // The cv_conversation_id owning a channel folder, read from any month note inside it, or null if
  // the folder is absent/empty. Uses the metadata cache when warm and only reads a file when it
  // isn't — so the common same-channel / new-folder path stays I/O-free.
  private async channelIdAt(folderPath: string): Promise<string | null> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath)
    if (!(folder instanceof TFolder)) return null
    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== 'md') continue
      const cached: unknown = this.app.metadataCache.getFileCache(child)?.frontmatter?.cv_conversation_id
      if (typeof cached === 'string') return cached
      const match = (await this.app.vault.read(child)).match(/^cv_conversation_id:\s*(\S+)/m)
      if (match) return match[1]
    }
    return null
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
    audioPath: string | null,
    aiResponses: RenderedAiResponse[]
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
      `time: ${yaml(m.created_at.slice(11, 16))}`,
      `duration: ${durationSec}`,
    ]
    const memoName = m.name?.trim()
    if (memoName) fm.push(`name: ${yaml(memoName)}`)
    if (summary) fm.push(`summary: ${yaml(summary)}`)
    if (wsName) fm.push(`workspace_name: ${yaml(wsName)}`)
    if (link && creatorName) fm.push(`person: ${yaml(this.personLink(creatorName))}`)
    fm.push('tags: [carbon-voice, voice-memo]', '---', '')

    const body: string[] = [`# ${title}`, '']
    if (summary) body.push('## Summary', summary, '')
    if (this.settings.includeTranscripts) {
      const readable = transcript
        ? formatTranscript(transcript, transcriptLanguage(m))
        : '> No transcript available yet.'
      body.push('## Transcript', readable, '')
    }
    if (aiResponses.length) {
      body.push('## AI Responses', '')
      for (const r of aiResponses) body.push(`### ${r.promptName}`, r.body, '')
    }
    body.push(...this.audioBlock(m, audioPath))

    body.push('## Metadata')
    if (link && creatorName) body.push(`- **From:** ${this.personLink(creatorName)}`)
    if (wsName) body.push(`- **Workspace:** ${wsName}`)
    body.push(
      `- **Date:** ${formatDateTime(m.created_at)}`,
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
    convMsgs: CarbonVoiceMessage[],
    promptNames: Map<string, string>,
    onTick?: () => void
  ): Promise<number> {
    const live = convMsgs.filter(m => !m.deleted_at && !isPending(m))
    const grouping = this.settings.messageGrouping
    // Dedupes /responses fetches across the run's messages/periods.
    const aiCache = new Map<string, RenderedAiResponse | null>()
    // Which (channel, period) files were touched? A period is a month, week, or day per the setting.
    const touched = new Map<string, Set<string>>()
    for (const m of live) {
      const period = periodKey(m.created_at, grouping)
      for (const ch of m.channel_ids) {
        if (!touched.has(ch)) touched.set(ch, new Set())
        touched.get(ch)!.add(period)
      }
    }

    let count = 0
    const channelCache = new Map<string, CarbonVoiceChannel>()
    // Tracks the folder each channel claimed this run, so two channels sharing a workspace + name
    // don't write into one folder — the second is disambiguated instead of overwriting the first.
    const claimed = new Map<string, string>()
    for (const [ch, periods] of touched) {
      let channel = channelCache.get(ch)
      if (!channel) {
        try {
          channel = await api.getChannel(ch)
          channelCache.set(ch, channel)
        } catch (err) {
          // The channel can't be fetched (e.g. deleted on the backend → 403). Drop it: skip its
          // messages entirely and carry on with the other channels rather than aborting the sync.
          console.warn(
            `Carbon Voice: skipping channel ${ch} — could not be fetched (${
              err instanceof Error ? err.message : String(err)
            })`
          )
          continue
        }
      }
      if (this.settings.linkNotes) await this.ensureEntityNotes(channel)
      const folder = await this.resolveChannelFolder(channel, claimed)
      // A per-conversation "home" note at the folder root: info up top, an embedded conversation-
      // scoped Bases table below. It's the linkable stand-in for the folder (Obsidian can't link a
      // folder directly) and each period note links back to it.
      const indexBase = `${folder}/${sanitize(channelName(channel))}`
      await this.ensureConversationIndex(channel, indexBase)
      for (const period of periods) {
        const msgs = (await this.fetchChannelPeriod(api, ch, period, grouping)).filter(
          m => !m.deleted_at && !isPending(m)
        )
        if (msgs.length === 0) continue
        msgs.sort((a, b) => a.created_at.localeCompare(b.created_at))
        const audioPaths =
          this.settings.audioMode === 'download'
            ? await this.collectAudio(api, msgs)
            : new Map<string, string>()
        const aiResponses = new Map<string, RenderedAiResponse[]>()
        for (const m of msgs) {
          const rendered = await this.fetchAiResponses(api, m, promptNames, aiCache)
          if (rendered.length) aiResponses.set(m.message_id, rendered)
        }
        const path = `${folder}/${periodFileLabel(period, grouping)}`
        await this.upsertFile(
          path,
          this.buildConversationNote(channel, period, grouping, indexBase, msgs, audioPaths, aiResponses)
        )
        count++
        onTick?.()
      }
    }
    return count
  }

  private buildConversationNote(
    channel: CarbonVoiceChannel,
    period: string,
    grouping: MessageGrouping,
    indexBase: string,
    messages: CarbonVoiceMessage[],
    audioPaths: Map<string, string>,
    aiResponses: Map<string, RenderedAiResponse[]>
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

    // Date/recency fields for by-date views (Bases/Dataview): `date` is the period's first day
    // (the day itself for day-grouping, the Monday for week, the 1st for month); `last_message_at`
    // is the newest message in the note — the "most recently touched" key an inbox-style view
    // sorts on so the freshest conversation floats to the top.
    const noteDate = periodBounds(period, grouping).start.slice(0, 10)
    const lastMessageAt = messages.reduce(
      (max, m) => (m.created_at > max ? m.created_at : max),
      messages[0]?.created_at ?? `${noteDate}T00:00:00.000Z`
    )

    const fm = [
      '---',
      `cv_conversation_id: ${channel.channel_guid}`,
      `conversation_link: https://carbonvoice.app/c/${channel.channel_guid}`,
      `conversation_name: ${yaml(title)}`,
      // The conversation name stored as a link to its "home" note: one column that shows the name
      // and clicks through to the whole conversation (the stand-in for its folder). The plain
      // `conversation_name` above stays for search/other queries.
      `conversation: ${yaml(`[[${indexBase}|${title}]]`)}`,
      `workspace_name: ${yaml(wsName)}`,
      `workspace_id: ${channel.workspace_guid}`,
    ]
    fm.push(
      `period: ${period}`,
      `grouping: ${grouping}`,
      `date: ${noteDate}`,
      `last_message_at: ${lastMessageAt}`,
      `message_count: ${messages.length}`,
      `participants: [${participantsFm.map(yaml).join(', ')}]`,
      // Plain-text mirror of `participants` (which holds wiki-links). Each People note embeds a Base
      // that filters on this with `participant_names.contains("<name>")` — string matching sidesteps
      // the link-resolution edge cases a list-of-links filter would hit. The links above stay for the
      // graph and backlinks.
      `participant_names: [${participants.map(yaml).join(', ')}]`,
      'tags: [carbon-voice]',
      '---',
      ''
    )
    const body: string[] = [`# ${title} — ${formatPeriod(period, grouping)}`, '']

    if (this.settings.includeTranscripts) {
      body.push('## Messages', '')
      for (const m of messages) {
        const senderName = nameById.get(m.creator_id) || 'Unknown'
        const sender = link && senderName !== 'Unknown' ? this.personLink(senderName) : senderName
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
          transcript ? formatTranscript(transcript, transcriptLanguage(m)) : '_[No transcript available]_',
          ''
        )
        body.push(...this.audioBlock(m, audioPaths.get(m.message_id) ?? null))
        for (const r of aiResponses.get(m.message_id) ?? []) {
          body.push(`**🤖 ${r.promptName}**`, '', r.body, '')
        }
        // Precise UTC timestamp (searchable with ⌘-Shift-F, unlike the local heading) plus a
        // stable block id derived from the message id, so a single message can be deep-linked or
        // bookmarked: [[<period> Messages#^cv-<id>]]. The id is deterministic, so it survives
        // re-syncs; Obsidian hides both the ^anchor and the <sub> chrome in reading view.
        const stamp = messageStamp(m.created_at)
        body.push(
          `<sub>🕒 ${stamp} · <a href="${url}">Open in Carbon Voice ↗</a></sub> ^cv-${blockAnchor(m.message_id)}`,
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

  // ── AI responses ───────────────────────────────────────────────────────────

  // prompt_id → display name, so a response can be headed by the prompt that produced it
  // (e.g. "Action Items"). Fetched once per run. Empty when AI responses are disabled or the
  // call fails — responses then fall back to a generic "AI Response" heading.
  private async fetchPromptNames(api: CarbonVoiceAPI): Promise<Map<string, string>> {
    if (!this.settings.includeAiResponses) return new Map()
    try {
      const prompts = await api.getPrompts()
      const map = new Map<string, string>()
      for (const p of prompts) if (p.id) map.set(p.id, p.name?.trim() || p.id)
      return map
    } catch (err) {
      console.warn('Carbon Voice: could not fetch prompt names', err)
      return new Map()
    }
  }

  // Fetches and renders the AI responses referenced by a message (its ai_response_ids). Returns []
  // when the feature is off or the message has none. Each id is fetched at most once per run via
  // `cache` — a response can be attached to several messages. Failures are logged and skipped so a
  // single bad response never aborts the sync.
  private async fetchAiResponses(
    api: CarbonVoiceAPI,
    m: CarbonVoiceMessage,
    promptNames: Map<string, string>,
    cache: Map<string, RenderedAiResponse | null>
  ): Promise<RenderedAiResponse[]> {
    if (!this.settings.includeAiResponses) return []
    const out: RenderedAiResponse[] = []
    for (const ref of m.ai_response_ids ?? []) {
      let rendered = cache.get(ref.id)
      if (rendered === undefined) {
        rendered = null
        try {
          const resp = await api.getResponse(ref.id)
          const body = renderAiResponseBody(resp)
          if (body) {
            const name =
              promptNames.get(ref.prompt_id) || promptNames.get(resp.prompt_id) || 'AI Response'
            rendered = { promptName: name, body }
          }
        } catch (err) {
          console.warn(`Carbon Voice: could not fetch AI response ${ref.id}`, err)
        }
        cache.set(ref.id, rendered)
      }
      if (rendered) out.push(rendered)
    }
    return out
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
    // Exact-case lookup only: on a case-sensitive filesystem two paths differing only in case are
    // genuinely separate notes, so we must not resolve one to the other here — that would clobber
    // a distinct file. Overwrite only when the exact path already holds a note.
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => content)
      return
    }
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) await this.ensureFolder(dir)
    try {
      await this.app.vault.create(path, content)
    } catch (err) {
      // The vault index is case-sensitive but macOS/Windows filesystems are not, so a path that
      // differs only in case from an existing note passes the exact-case check above yet collides
      // on disk — Obsidian throws "File already exists". Recover by overwriting the note that
      // actually occupies the slot instead of aborting the whole import. Only reached on a throw,
      // so case-sensitive filesystems (where create succeeds) never pay this scan. Re-throw when
      // nothing resolves — a genuine error, or a folder occupying the path we can't overwrite.
      const collided = this.resolveCaseInsensitive(path)
      if (!collided) throw err
      await this.app.vault.process(collided, () => content)
    }
  }

  // Finds the note occupying `path` on a case-insensitive filesystem when the exact-case index
  // lookup missed. The on-disk collision can differ in case at any segment (folder or leaf), so we
  // descend the tree one level at a time, matching each segment against the current folder's
  // children case-insensitively. This resolves the same file the old whole-vault scan did without
  // ever enumerating the entire vault — each step only inspects the children of the folder we're
  // already inside. Returns null when no note (folders don't count) occupies the path.
  private resolveCaseInsensitive(path: string): TFile | null {
    const segments = normalizePath(path).split('/')
    let folder: TFolder = this.app.vault.getRoot()
    for (let depth = 0; depth < segments.length - 1; depth++) {
      const wanted = segments[depth].toLowerCase()
      const sub = folder.children.find(
        (c): c is TFolder => c instanceof TFolder && c.name.toLowerCase() === wanted,
      )
      if (!sub) return null
      folder = sub
    }
    const leaf = segments[segments.length - 1].toLowerCase()
    const file = folder.children.find(
      (c): c is TFile => c instanceof TFile && c.name.toLowerCase() === leaf,
    )
    return file ?? null
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

  // Writes the ready-made Bases views into the vault once — "Conversations by Date" and
  // "All Voice Memos" both at the sync root — so they ship with the plugin.
  // Create-if-absent: never overwrites, so a user's edits (or deletion) stick. Requires Obsidian's
  // core Bases plugin to render.
  private async ensureBaseViews(): Promise<void> {
    await this.createIfAbsent(`${this.root()}/Conversations by Date.base`, CONVERSATIONS_BASE)
    await this.createIfAbsent(`${this.root()}/All Voice Memos.base`, VOICE_MEMOS_BASE)
  }

  // Writes a conversation "home" note at the folder root: identity/metadata up top, an embedded
  // conversation-scoped Bases table below (its period notes, newest first). This is the linkable
  // stand-in for the folder. Create-if-absent so user edits stick; the embedded table stays live
  // since it queries the period notes rather than hard-coding them. `indexBase` has no extension.
  private async ensureConversationIndex(
    channel: CarbonVoiceChannel,
    indexBase: string
  ): Promise<void> {
    const name = channelName(channel)
    const wsName = channel.workspace_name ?? ''
    const url = `https://carbonvoice.app/c/${channel.channel_guid}`
    const lines = [
      '---',
      `cv_conversation_id: ${channel.channel_guid}`,
      `conversation_name: ${yaml(name)}`,
      `workspace_name: ${yaml(wsName)}`,
      `workspace_id: ${channel.workspace_guid}`,
      `conversation_link: ${url}`,
      'tags: [carbon-voice, conversation]',
      '---',
      '',
      `# ${name}`,
      '',
    ]
    if (wsName) lines.push(`- **Workspace:** ${wsName}`)
    lines.push(
      `- [Open in Carbon Voice ↗](${url})`,
      '',
      '> Conversation home. The table below lists this conversation’s notes (grouped by month, week,',
      '> or day per the sync setting), newest first — click one to open that period’s messages.',
      '',
      // Embedded Bases view (core Bases plugin). Scoped to this conversation by its id, and limited
      // to period notes via `grouping` so the home note doesn't list itself.
      '```base',
      'filters:',
      '  and:',
      `    - 'cv_conversation_id == "${channel.channel_guid}"'`,
      '    - or:',
      `        - 'grouping == "month"'`,
      `        - 'grouping == "week"'`,
      `        - 'grouping == "day"'`,
      'views:',
      '  - type: table',
      '    name: Messages by period',
      '    order:',
      '      - file.name',
      '      - date',
      '      - message_count',
      '      - last_message_at',
      '```',
      '',
    )
    await this.createIfAbsent(`${indexBase}.md`, lines.join('\n'))
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

  private async ensureEntityNotes(channel: CarbonVoiceChannel): Promise<void> {
    for (const c of channel.json_collaborators ?? []) {
      const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.user_guid
      await this.ensurePersonNote(name)
    }
  }

  private async ensurePersonNote(name: string): Promise<void> {
    const path = `${this.root()}/People/${sanitize(name)}.md`
    // Bases filter string literal: escape backslashes then double-quotes for the inner
    // `contains("…")` argument, then double single-quotes for the surrounding YAML scalar. Names
    // like O'Brien or 21" Monitor otherwise break the embedded block.
    const filter = `participant_names.contains("${name
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')}")`.replace(/'/g, "''")
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
        '> Auto-created by Carbon Voice Sync. ',
        '> Add your own notes here — a later sync never overwrites this file',
        '> The table below lists every conversation this person takes part in (Last used first)',
        '> Open the backlinks pane to see see links to all their messages.',
        '',
        // Embedded Bases view (core Bases plugin, 1.9+). Scoped to this person via the plain-text
        // `participant_names` on conversation notes, and to period notes via `grouping` so conversation
        // "home" notes and voice memos don't show up. Queries live, so new conversations appear here
        // automatically without rewriting this note.
        '```base',
        'filters:',
        '  and:',
        `    - '${filter}'`,
        '    - or:',
        `        - 'grouping == "month"'`,
        `        - 'grouping == "week"'`,
        `        - 'grouping == "day"'`,
        'views:',
        '  - type: table',
        '    name: Conversations',
        '    sort:',
        '      - property: last_message_at',
        '        direction: DESC',
        '    order:',
        '      - conversation',
        '      - workspace_name',
        '      - date',
        '      - message_count',
        '      - last_message_at',
        '```',
        '',
      ].join('\n')
    )
  }


  // ── Audio ─────────────────────────────────────────────────────────────────

  // The audio player block for one message, per the active audio mode. Returns lines to splice
  // into the note body (empty for text messages, mode 'off', or a missing download).
  private audioBlock(m: CarbonVoiceMessage, downloadedPath: string | null): string[] {
    if (m.is_text_message) return []
    // Only 'download' renders a player; 'off' relies on the note's "Open in Carbon Voice" link.
    if (this.settings.audioMode === 'download' && downloadedPath) return [`![[${downloadedPath}]]`, '']
    return []
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

function channelName(c: CarbonVoiceChannel): string {
  return c.channel_name?.trim() || `Conversation ${c.channel_guid.slice(0, 8)}`
}

// The Markdown body for one AI response. A response holds a variant per language; we take the
// first that renders something, preferring Markdown, then plain text, then a fenced JSON dump of a
// structured (json-format) response. HTML-only variants are skipped to avoid dumping raw HTML into
// the note. Returns null when nothing renders.
function renderAiResponseBody(resp: CarbonVoiceAiResponse): string | null {
  for (const v of resp.responses ?? []) {
    const md = v.markdown?.trim()
    if (md) return md
    const txt = v.text?.trim()
    if (txt) return txt
    if (v.json && Object.keys(v.json).length) {
      return '```json\n' + JSON.stringify(v.json, null, 2) + '\n```'
    }
  }
  return null
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

// Language of a message's transcript, taken from the same text model `messageTranscript` reads.
// Feeds the paragraph formatter so each transcript is reflowed with its own language's rules.
function transcriptLanguage(m: CarbonVoiceMessage): string | undefined {
  for (const type of ['transcript', 'transcript_with_timecode']) {
    const model = m.text_models?.find(t => t.type === type)
    if (model) return model.language_id || undefined
  }
  return undefined
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

// Minimal YAML string escaping for frontmatter scalar values. Multi-line values (e.g. an AI
// summary) are kept on one line via double-quoted `\n` escapes so they stay valid, table-friendly
// properties rather than spilling raw newlines into the frontmatter block.
function yaml(value: string): string {
  if (/[:#[\]{}",&*!|>'%@`\n\r\t]/.test(value) || value.trim() !== value) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
    return `"${escaped}"`
  }
  return value
}

// The grouping key a message's timestamp falls into (all UTC): "YYYY-MM" for month, the Monday
// date "YYYY-MM-DD" for week, or "YYYY-MM-DD" for day.
function periodKey(iso: string, grouping: MessageGrouping): string {
  switch (grouping) {
    case 'day':
      return iso.slice(0, 10)
    case 'week':
      return weekStartKey(iso)
    default:
      return iso.slice(0, 7)
  }
}

// The Monday (UTC) that starts the ISO week containing `iso`, as "YYYY-MM-DD".
function weekStartKey(iso: string): string {
  const d = new Date(iso)
  const dow = d.getUTCDay() // 0=Sun … 6=Sat
  const backToMonday = dow === 0 ? 6 : dow - 1
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - backToMonday))
  return monday.toISOString().slice(0, 10)
}

// Half-open [start, end) UTC bounds for a period key under the active grouping.
function periodBounds(key: string, grouping: MessageGrouping): { start: string; end: string } {
  if (grouping === 'month') {
    const [y, m] = key.split('-').map(Number)
    const start = new Date(Date.UTC(y, m - 1, 1))
    const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1))
    return { start: start.toISOString(), end: end.toISOString() }
  }
  // Day and week both key off a calendar date; Date.UTC normalises day overflow past month/year.
  const [y, m, d] = key.split('-').map(Number)
  const span = grouping === 'week' ? 7 : 1
  const start = new Date(Date.UTC(y, m - 1, d))
  const end = new Date(Date.UTC(y, m - 1, d + span))
  return { start: start.toISOString(), end: end.toISOString() }
}

// Filename for a period's note. Month/day are just the key; week adds a "Week" marker so a week
// file never collides with the same-dated day file.
function periodFileLabel(key: string, grouping: MessageGrouping): string {
  return grouping === 'week' ? `${key} Week Messages.md` : `${key} Messages.md`
}

// Human heading for a period: "July 2026", "Week of July 6, 2026", or "July 6, 2026".
function formatPeriod(key: string, grouping: MessageGrouping): string {
  if (grouping === 'month') {
    const [y, m] = key.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })
  }
  const [y, m, d] = key.split('-').map(Number)
  const full = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
  return grouping === 'week' ? `Week of ${full}` : full
}

function formatDayShort(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric' })
}

// Minute-precision UTC stamp for a message's metadata line, e.g. "2026-07-12T15:04Z". Unlike the
// locale-formatted heading time, this is deterministic text that an exact date/time search hits.
function messageStamp(iso: string): string {
  return `${iso.slice(0, 16)}Z`
}

// A safe, stable Obsidian block-id fragment from a message id: strip non-alphanumerics (block ids
// allow only [A-Za-z0-9-]) and keep a short, collision-free-within-a-note slice. Deterministic, so
// the anchor is identical across re-syncs and existing deep links keep resolving.
function blockAnchor(messageId: string): string {
  const cleaned = messageId.replace(/[^a-zA-Z0-9]/g, '')
  return cleaned.slice(0, 12) || 'msg'
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
