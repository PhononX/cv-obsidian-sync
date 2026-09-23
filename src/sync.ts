import { TFile, TFolder, normalizePath } from 'obsidian'
import type CarbonVoiceSyncPlugin from './main'
import { CarbonVoiceAPI, CarbonVoiceApiError } from './api'
import type { MessagePageV6, MessagesV6QueryParams } from './api'
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

// An AI response synced to its own note in the Artifacts folder. `promptName` is the human label
// (the prompt that produced it); `linkTarget` is that note's vault path without extension, so a
// message can wiki-link to it. Built by writeArtifact from a response object.
interface RenderedAiResponse {
  promptName: string
  linkTarget: string
}

// Shared state for the AI-response pass, built once per run.
interface AiContext {
  // prompt_id → prompt name, which labels a response and names its artifact folder.
  promptNames: Map<string, string>
  // False when GET /prompts failed. New artifacts are then held back rather than filed under a
  // generic folder they'd stay in; notes that already exist are still linked and refreshed.
  promptsLoaded: boolean
  // Workspace id → name for memo and artifact paths, fetched on first use and at most once per run.
  loadWorkspaces: () => Promise<Map<string, string>>
  // Response id → its artifact link (or null when it produced no note / failed), so message
  // linking is a lookup and each response is written at most once per run.
  index: Map<string, RenderedAiResponse | null>
  // Source message id → response ids attributed to it by the /responses feed (from each response's
  // message_ids), complementing the ai_response_ids on the message itself.
  byMessage: Map<string, Set<string>>
  // Artifact notes already in the vault, by cv_response_id. A response keeps its note even if the
  // prompt or workspace that shaped its path was renamed, and linking to it needs no fetch.
  existingArtifacts: Map<string, TFile>
  // Which response owns each artifact note path this run, so two responses sharing a date + type +
  // prompt + workspace don't overwrite each other.
  claimedArtifacts: Map<string, string>
}

export interface SyncResult {
  firstRun: boolean
  conversations: number // conversation month-files written
  voiceMemos: number // voice memo notes written
  artifacts: number // AI response notes written
}

// Live progress reported to the caller so a toast can show work as it happens. `fetching` covers
// the message pull (only `fetched` is meaningful then); `writing` covers note creation, where the
// running `conversations` / `voiceMemos` / `artifacts` counts climb as files are saved.
export interface SyncProgress {
  phase: 'fetching' | 'writing'
  fetched: number
  conversations: number
  voiceMemos: number
  artifacts: number
}

const PAGE = 50
// Top-level folder (under the sync root) holding one note per AI response.
const ARTIFACTS_DIR = 'AI artifacts'
// The "Bulleted Summary" prompt, which the server auto-runs on nearly every new message (id is
// hard-coded in cv-api's message.service.ts). On conversation messages it would flood AI artifacts,
// so it's skipped there; on voice memos it's kept.
const BULLETED_SUMMARY_PROMPT_ID = '66859b7f6928970bb4f1c24a'

// Whether an AI response is left out of AI artifacts: a Bulleted Summary on a conversation message
// (one with a channel). `channelId` is the response's channel, or the message's for a reference.
function isExcludedArtifact(promptId: string | null | undefined, channelId: string | null | undefined): boolean {
  return promptId === BULLETED_SUMMARY_PROMPT_ID && !!channelId
}
// v6 message feeds are keyset-paginated and reliable at their default page size, so we request the
// larger page to cut round-trips (the /responses feed keeps the smaller PAGE).
const MESSAGE_PAGE = 200
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

// Ready-made "All AI Artifacts" Bases view, written at the sync root. Selects artifact notes by
// their tag and lists them newest-first. `file.name` is the clickable column that opens the
// artifact; open the backlinks pane on any artifact to see the messages that reference it.
const ARTIFACTS_BASE = `filters:
  and:
    - file.hasTag("ai-response")
views:
  - type: table
    name: All AI artifacts
    order:
      - file.name
      - prompt_name
      - workspace_name
      - source_type
      - date
    sort:
      - property: date
        direction: DESC
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

  // Forward incremental sync. First run only sets the baseline (no historical pull). After that,
  // updates are pulled from the /v6/messages/updates keyset feed: the first request is anchored by
  // date, and every run after resumes from the cursor it stored, never falling back to a date. So
  // each run reads only what changed since the last one (plus, while that boundary is recent, up to
  // 4s of re-delivered messages, which are de-duplicated by id and rewrite the same notes).
  async syncIncremental(onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
    const api = new CarbonVoiceAPI(this.settings.apiToken)
    await this.ensureBaseViews()
    const startedAt = new Date().toISOString()
    const since = this.settings.lastSyncTimestamp
    const savedCursor = this.settings.updatesCursor

    // First run ever: record the baseline and pull nothing (use Historical import for back-fill).
    // The next run date-anchors from this baseline and captures the first cursor.
    if (since == null && savedCursor == null) {
      this.settings.lastSyncTimestamp = startedAt
      await this.plugin.saveSettings()
      return { firstRun: true, conversations: 0, voiceMemos: 0, artifacts: 0 }
    }

    const progress: SyncProgress = {
      phase: 'fetching',
      fetched: 0,
      conversations: 0,
      voiceMemos: 0,
      artifacts: 0,
    }
    const onFetch = (n: number) => {
      progress.fetched = n
      onProgress?.(progress)
    }
    // Resume from the stored cursor; only date-anchor when we don't have one yet (the first real
    // incremental run). `since` is non-null here because the first-run branch above returned.
    const dateAnchor = since ?? startedAt
    let collected: { messages: CarbonVoiceMessage[]; nextCursor: string | null }
    let cursorRejected = false
    try {
      collected = await this.collectUpdates(
        api,
        savedCursor ? { cursor: savedCursor } : { date: dateAnchor },
        onFetch
      )
    } catch (err) {
      // Only a cursor the server refuses (400 "Invalid cursor") is dropped, by re-anchoring on the
      // last-synced date; otherwise it would wedge every future sync. Any other failure (offline,
      // 5xx, auth) aborts the run and leaves the stored cursor untouched for the next attempt.
      if (!savedCursor || !(err instanceof CarbonVoiceApiError && err.status === 400)) throw err
      console.warn('Carbon Voice: updates cursor rejected; re-anchoring by date', err)
      cursorRejected = true
      collected = await this.collectUpdates(api, { date: dateAnchor }, onFetch)
    }
    const messages = collected.messages
    progress.phase = 'writing'
    const memos = messages.filter(m => this.isVoiceMemo(m) && this.memoInScope(m))
    const convMsgs = await this.selectConversationMessages(api, messages)

    const ai = await this.buildAiContext(api)
    const artifacts = await this.syncResponses(api, dateAnchor, ai, {
      onWritten: n => {
        progress.artifacts = n
        onProgress?.(progress)
      },
    })
    const voiceMemos = await this.processVoiceMemos(api, memos, ai, () => {
      progress.voiceMemos++
      onProgress?.(progress)
    })
    const conversations = await this.processConversations(api, convMsgs, ai, () => {
      progress.conversations++
      onProgress?.(progress)
    })

    // Persist the resume cursor so the next run continues from here. A rejected cursor is cleared
    // only now, after the date-anchored retry succeeded, and only if that retry returned none (an
    // empty date-anchored page carries no cursor). Keep the timestamp too — as the "last synced"
    // display and the date seed if the cursor ever has to be rebuilt.
    if (collected.nextCursor) this.settings.updatesCursor = collected.nextCursor
    else if (cursorRejected) this.settings.updatesCursor = null
    this.settings.lastSyncTimestamp = startedAt
    await this.plugin.saveSettings()
    return { firstRun: false, conversations, voiceMemos, artifacts }
  }

  // Explicit historical pull for conversations and voice memos — both come from the messages
  // endpoint, so they're fetched together in a single pass and split per category. Each has its own
  // window and can be set to 'none' to skip it. AI responses are imported separately (they use a
  // different endpoint) via importArtifacts. Does not touch the incremental baseline.
  async importHistory(
    conversationWindow: HistoryWindow,
    voiceMemoWindow: HistoryWindow,
    onProgress?: (p: SyncProgress) => void
  ): Promise<SyncResult> {
    const api = new CarbonVoiceAPI(this.settings.apiToken)
    await this.ensureBaseViews()
    const progress: SyncProgress = {
      phase: 'fetching',
      fetched: 0,
      conversations: 0,
      voiceMemos: 0,
      artifacts: 0,
    }
    const doConv = conversationWindow !== 'none'
    const doMemo = voiceMemoWindow !== 'none'
    if (!doConv && !doMemo) {
      return { firstRun: false, conversations: 0, voiceMemos: 0, artifacts: 0 }
    }

    const convSince = doConv ? this.windowToSince(conversationWindow) : null
    const memoSince = doMemo ? this.windowToSince(voiceMemoWindow) : null
    // Fetch once over the earliest requested window, then filter each category by its own.
    const earliest = [convSince, memoSince]
      .filter((s): s is string => s != null)
      .reduce((a, b) => (a < b ? a : b))
    const messages = await this.collectCreatedSince(api, earliest, n => {
      progress.fetched = n
      onProgress?.(progress)
    })
    progress.phase = 'writing'

    // The /responses feed over the same span, writing artifacts only for the categories being
    // imported and each within its own window — so a 'None' category pulls none, and a short
    // conversation window isn't widened to the voice-memo one. Honours the AI-artifacts toggle
    // inside syncResponses.
    const ai = await this.buildAiContext(api)
    const artifacts = await this.syncResponses(api, earliest, ai, {
      onWritten: n => {
        progress.artifacts = n
        onProgress?.(progress)
      },
      accept: r =>
        r.channel_id
          ? convSince != null && r.created_at >= convSince
          : memoSince != null && r.created_at >= memoSince,
    })

    let voiceMemos = 0
    if (doMemo) {
      const memoMsgs = messages.filter(
        m => m.created_at >= memoSince! && this.isVoiceMemo(m) && this.memoInScope(m)
      )
      voiceMemos = await this.processVoiceMemos(api, memoMsgs, ai, () => {
        progress.voiceMemos++
        onProgress?.(progress)
      })
    }

    let conversations = 0
    if (doConv) {
      const convCandidates = messages.filter(m => m.created_at >= convSince!)
      const convMsgs = await this.selectConversationMessages(api, convCandidates)
      conversations = await this.processConversations(api, convMsgs, ai, () => {
        progress.conversations++
        onProgress?.(progress)
      })
    }

    return { firstRun: false, conversations, voiceMemos, artifacts }
  }

  // Explicit historical import of AI responses only, over `window` (or nothing when 'none'), straight
  // from the /responses feed — a different endpoint from the message import above. Writes/refreshes
  // artifact notes without touching messages or the incremental baseline; honours the conversation
  // and voice-memo scopes. Message → artifact links fill in on the next message sync/import.
  // Returns the count written.
  async importArtifacts(
    window: HistoryWindow,
    onProgress?: (written: number) => void
  ): Promise<number> {
    if (window === 'none' || !this.settings.includeAiResponses) return 0
    const api = new CarbonVoiceAPI(this.settings.apiToken)
    await this.ensureBaseViews()
    const ai = await this.buildAiContext(api)
    return this.syncResponses(api, this.windowToSince(window), ai, { onWritten: onProgress })
  }

  // ── Message fetching ────────────────────────────────────────────────────

  // Pages a v6 message feed forward (direction 'newer') from an anchor — either a stored `cursor`
  // (resume) or a `date` (first request only; the server look-back applies). Follows next_cursor
  // until has_more=false, and returns the last cursor seen so the caller can persist it as the resume
  // point. An empty page reached via a cursor echoes that cursor back; an empty date-anchored first
  // page returns null, so the next run anchors by date again. Rows are keyed by id, which also
  // absorbs the up-to-4s re-delivery a recent resume cursor can produce. Per the keyset contract we
  // never stop on a short page — only on has_more=false.
  private async collectMessagesForward(
    fetchPage: (q: MessagesV6QueryParams) => Promise<MessagePageV6>,
    anchor: { date?: string; cursor?: string },
    onFetch?: (total: number) => void
  ): Promise<{ messages: CarbonVoiceMessage[]; nextCursor: string | null }> {
    const out = new Map<string, CarbonVoiceMessage>()
    let cursor = anchor.cursor
    let date = anchor.cursor ? undefined : anchor.date
    // Seed the resume point with the incoming cursor so an empty response (nothing new) keeps it.
    let tail: string | null = anchor.cursor ?? null
    const presigned_url = this.wantsPresignedAudio()
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await fetchPage(
        cursor
          ? { cursor, direction: 'newer', limit: MESSAGE_PAGE, presigned_url }
          : { date, direction: 'newer', limit: MESSAGE_PAGE, presigned_url }
      )
      for (const m of page.messages) out.set(m.message_id, m)
      onFetch?.(out.size)
      if (page.nextCursor) tail = page.nextCursor
      if (!page.hasMore || !page.nextCursor) break
      cursor = page.nextCursor
      date = undefined
    }
    return { messages: [...out.values()], nextCursor: tail }
  }

  // In download mode, ask the list endpoints for signed S3 audio links. The plain `content.url` is
  // an API route rather than a signed file, so downloading from it would fail and cost an extra
  // get-by-id call per message to fetch a signed one. Signed links are only ever used for the
  // immediate download — notes embed the local file, never the URL.
  private wantsPresignedAudio(): boolean {
    return this.settings.audioMode === 'download'
  }

  // Incremental feed (GET /v6/messages/updates): everything created or changed since the anchor,
  // ordered by last_updated_at — so a message whose status/transcript later changes resurfaces.
  // Returns the tail cursor to persist for the next run.
  private collectUpdates(
    api: CarbonVoiceAPI,
    anchor: { date?: string; cursor?: string },
    onFetch?: (total: number) => void
  ): Promise<{ messages: CarbonVoiceMessage[]; nextCursor: string | null }> {
    return this.collectMessagesForward(q => api.getMessageUpdatesV6(q), anchor, onFetch)
  }

  // History feed (GET /v6/messages): everything created at/after `sinceIso`, ordered by created_at.
  // A one-shot windowed pull — no cursor is persisted.
  private async collectCreatedSince(
    api: CarbonVoiceAPI,
    sinceIso: string,
    onFetch?: (total: number) => void
  ): Promise<CarbonVoiceMessage[]> {
    const { messages } = await this.collectMessagesForward(
      q => api.getMessagesV6(q),
      { date: sinceIso },
      onFetch
    )
    return messages
  }

  // A single channel's messages within one grouping period (month / week / day), paging older from
  // the period end via GET /v6/messages scoped to the conversation. Keyset paging stops on
  // has_more=false; we also stop early once a page reaches past the period start.
  private async fetchChannelPeriod(
    api: CarbonVoiceAPI,
    channelGuid: string,
    periodKey: string,
    grouping: MessageGrouping
  ): Promise<CarbonVoiceMessage[]> {
    const { start, end } = periodBounds(periodKey, grouping)
    const out = new Map<string, CarbonVoiceMessage>()
    let cursor: string | undefined
    const scope = {
      direction: 'older' as const,
      limit: MESSAGE_PAGE,
      conversation_id: channelGuid,
      presigned_url: this.wantsPresignedAudio(),
    }
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api.getMessagesV6(cursor ? { ...scope, cursor } : { ...scope, date: end })
      let pagedPastStart = false
      for (const m of page.messages) {
        if (m.created_at >= start && m.created_at < end) out.set(m.message_id, m)
        if (m.created_at < start) pagedPastStart = true
      }
      if (pagedPastStart || !page.hasMore || !page.nextCursor) break
      cursor = page.nextCursor
    }
    return [...out.values()]
  }

  // ── Voice memos ─────────────────────────────────────────────────────────

  private async processVoiceMemos(
    api: CarbonVoiceAPI,
    memos: CarbonVoiceMessage[],
    ai: AiContext,
    onTick?: () => void
  ): Promise<number> {
    const live = memos.filter(m => !m.deleted_at && !isPending(m))
    if (live.length === 0) return 0

    const folders = await this.fetchFolders(api)
    const workspaces = await ai.loadWorkspaces()
    // Memo notes already in the vault, by memo id. A memo keeps its existing note even when its
    // computed title changes — e.g. v6 no longer sends a memo's name, so a named memo's title now
    // falls back to its summary; without this, re-syncing it would fork a second note.
    const existingNotes = this.notesByFrontmatterId(`${this.root()}/Voice Memos`, 'cv_memo_id')

    let count = 0
    // Tracks the note path each memo claimed this run, so two same-titled memos in one import
    // don't fight over one file — the second is disambiguated instead of overwriting the first.
    const claimed = new Map<string, string>()
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
      const aiResponses = await this.resolveAiLinks(api, m, ai)
      const existing = existingNotes.get(m.message_id)
      let path: string
      if (existing) {
        path = existing.path
        claimed.set(path, m.message_id)
      } else {
        const basePath = `${this.root()}/Voice Memos/${subpath}/${sanitize(title)}.md`
        path = await this.resolveMemoNotePath(basePath, m, claimed)
      }
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
      for (const r of aiResponses) body.push(`- 🤖 ${artifactLink(r.linkTarget, r.promptName)}`)
      body.push('')
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
    ai: AiContext,
    onTick?: () => void
  ): Promise<number> {
    const live = convMsgs.filter(m => !m.deleted_at && !isPending(m))
    const grouping = this.settings.messageGrouping
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
          const rendered = await this.resolveAiLinks(api, m, ai)
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
        const arts = aiResponses.get(m.message_id) ?? []
        if (arts.length) {
          body.push('**AI responses**', '')
          body.push(...arts.map(r => `- 🤖 ${artifactLink(r.linkTarget, r.promptName)}`), '')
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

  // Whether a response from the /responses feed falls within what the user syncs, so the bulk feed
  // pass only writes artifacts for in-scope messages. A response on a conversation message (it has
  // a channel_id) follows the conversation scope — the single-valued analogue of convInScope +
  // matchesAsyncRule. One on a voice memo (no channel_id) follows the voice-memo scope; a
  // folder-scoped memo can't be matched here because a response carries no folder, so those are
  // skipped and written by resolveAiLinks as each in-scope memo syncs. That per-message path also
  // covers any other in-scope response the feed misses (e.g. one outside its window).
  private responseInScope(resp: CarbonVoiceAiResponse): boolean {
    const s = this.settings
    if (!resp.channel_id) {
      switch (s.voiceMemoScope) {
        case 'by_workspace':
          return !!resp.workspace_id && s.voiceMemoWorkspaceIds.includes(resp.workspace_id)
        case 'by_folder':
          return false
        default:
          return true
      }
    }
    switch (s.conversationScope) {
      case 'by_workspace':
        return !!resp.workspace_id && s.conversationWorkspaceIds.includes(resp.workspace_id)
      case 'by_conversation': {
        if (resp.channel_id && s.conversationIds.includes(resp.channel_id)) return true
        // Honour "all async meetings in <workspace>" rules, like matchesAsyncRule.
        const asyncWs = this.asyncRuleWorkspaceIds()
        return (
          asyncWs.size > 0 &&
          !!resp.workspace_id &&
          asyncWs.has(resp.workspace_id) &&
          !!resp.channel_id &&
          s.channelTypeCache[resp.channel_id] === 'asyncMeeting'
        )
      }
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

  // Builds the run's AI-response context. Prompt names and the existing-artifact index are only
  // loaded when AI artifacts are on, and workspace names only when something needs them — so a
  // quiet sync with nothing to write makes no /prompts or /workspaces calls.
  private async buildAiContext(api: CarbonVoiceAPI): Promise<AiContext> {
    const promptNames = new Map<string, string>()
    let promptsLoaded = false
    if (this.settings.includeAiResponses) {
      try {
        for (const p of await api.getPrompts()) if (p.id) promptNames.set(p.id, p.name?.trim() || p.id)
        promptsLoaded = true
      } catch (err) {
        console.warn('Carbon Voice: could not fetch prompt names; holding back new AI artifacts', err)
      }
    }
    let workspaces: Promise<Map<string, string>> | null = null
    return {
      promptNames,
      promptsLoaded,
      loadWorkspaces: () => (workspaces ??= this.fetchWorkspaceNames(api)),
      index: new Map(),
      byMessage: new Map(),
      existingArtifacts: this.settings.includeAiResponses
        ? this.notesByFrontmatterId(`${this.root()}/${ARTIFACTS_DIR}`, 'cv_response_id')
        : new Map(),
      claimedArtifacts: new Map(),
    }
  }

  // Notes under `folder` keyed by a frontmatter id (e.g. cv_memo_id, cv_response_id), so an item
  // that was already synced is found wherever its note lives — even if the title, prompt or
  // workspace that shaped its path has since changed. Reads the metadata cache only, never files.
  private notesByFrontmatterId(folder: string, key: string): Map<string, TFile> {
    const out = new Map<string, TFile>()
    const root = this.app.vault.getAbstractFileByPath(normalizePath(folder))
    if (!(root instanceof TFolder)) return out
    const walk = (dir: TFolder) => {
      for (const child of dir.children) {
        if (child instanceof TFolder) walk(child)
        else if (child instanceof TFile && child.extension === 'md') {
          const id: unknown = this.app.metadataCache.getFileCache(child)?.frontmatter?.[key]
          if (typeof id === 'string' && !out.has(id)) out.set(id, child)
        }
      }
    }
    walk(root)
    return out
  }

  // The link for an artifact note already in the vault. The label is the prompt's current name
  // when known, else the name recorded in the note.
  private existingArtifactLink(file: TFile, ai: AiContext, promptId?: string): RenderedAiResponse {
    const recorded: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.prompt_name
    const promptName =
      (promptId && ai.promptNames.get(promptId)) ||
      (typeof recorded === 'string' && recorded) ||
      'AI Response'
    return { promptName, linkTarget: file.path.replace(/\.md$/i, '') }
  }

  // Syncs AI responses directly from the /responses feed, paging forward from `sinceIso` and
  // writing each in-scope one to its own artifact note. This is the bulk artifact sync; it also
  // populates `ai.index` so message linking is a lookup rather than a per-message fetch. `accept`
  // narrows it further (history import uses it to keep only the categories and windows being
  // imported). Returns the number of artifact notes written.
  private async syncResponses(
    api: CarbonVoiceAPI,
    sinceIso: string,
    ai: AiContext,
    opts: {
      onWritten?: (n: number) => void
      accept?: (resp: CarbonVoiceAiResponse) => boolean
    } = {}
  ): Promise<number> {
    const { onWritten, accept } = opts
    if (!this.settings.includeAiResponses) return 0
    let written = 0
    let cursor = sinceIso
    for (let i = 0; i < MAX_PAGES; i++) {
      let page
      try {
        page = await api.getResponses({ date: cursor, direction: 'newer', limit: PAGE })
      } catch (err) {
        // The feed endpoint is unavailable — stop the pass. Message-referenced responses still get
        // picked up individually by resolveAiLinks' fallback.
        console.warn('Carbon Voice: could not fetch AI responses feed', err)
        break
      }
      if (page.length === 0) break
      let newest = cursor
      for (const resp of page) {
        if (
          !ai.index.has(resp.id) &&
          this.responseInScope(resp) &&
          (accept?.(resp) ?? true) &&
          (await this.writeArtifact(resp, ai))
        ) {
          written++
          onWritten?.(written)
        }
        // Advance by created_at — the feed's `date` orders by creation, like the message scans.
        if (resp.created_at > newest) newest = resp.created_at
      }
      // A short page is not end-of-data (the endpoint may cap page size); stop only when a page is
      // empty or the cursor can't move forward.
      if (newest === cursor) break
      cursor = newest
    }
    return written
  }

  // Resolves the artifact links for a message: the response ids on the message itself
  // (ai_response_ids) plus any the /responses feed attributed to it this run (`ai.byMessage`),
  // de-duplicated. A response whose note already exists is linked as-is, with no fetch or rewrite —
  // otherwise every sync touching a conversation period would re-download and rewrite the
  // artifacts of all its messages. Existing notes are refreshed only by the /responses feed and the
  // AI artifacts import. Only responses with no note yet are fetched; failures are logged and skipped.
  private async resolveAiLinks(
    api: CarbonVoiceAPI,
    m: CarbonVoiceMessage,
    ai: AiContext
  ): Promise<RenderedAiResponse[]> {
    if (!this.settings.includeAiResponses) return []
    const ids = new Set<string>(ai.byMessage.get(m.message_id) ?? [])
    for (const ref of m.ai_response_ids ?? []) {
      // Checked on the reference so an excluded response is never fetched — nearly every
      // conversation message carries a Bulleted Summary.
      if (isExcludedArtifact(ref.prompt_id, m.channel_ids[0])) continue
      ids.add(ref.id)
      if (ai.index.has(ref.id)) continue
      const existing = ai.existingArtifacts.get(ref.id)
      if (existing) {
        ai.index.set(ref.id, this.existingArtifactLink(existing, ai, ref.prompt_id))
        continue
      }
      try {
        await this.writeArtifact(await api.getResponse(ref.id), ai)
      } catch (err) {
        console.warn(`Carbon Voice: could not fetch AI response ${ref.id}`, err)
        ai.index.set(ref.id, null)
      }
    }
    const out: RenderedAiResponse[] = []
    for (const id of ids) {
      const hit = ai.index.get(id)
      if (hit) out.push(hit)
    }
    return out
  }

  // Writes one response's artifact note (upserted, since a response can be regenerated) and records
  // it in `ai.index`. Records null — so it's never retried — when the response renders no body.
  // Returns true when a note was written. The note path is
  //   AI artifacts/<workspace>/<prompt name>/<date>-<voice memo|conversation message>.md
  // browsable by workspace and prompt; a short response-id tag is appended only when a *different*
  // response would otherwise collide (see resolveArtifactNotePath).
  private async writeArtifact(resp: CarbonVoiceAiResponse, ai: AiContext): Promise<boolean> {
    const body = isExcludedArtifact(resp.prompt_id, resp.channel_id) ? null : renderAiResponseBody(resp)
    if (!body) {
      ai.index.set(resp.id, null)
      return false
    }
    // A response that already has a note keeps it, so a renamed prompt or workspace (or a failed
    // /prompts call) never forks a duplicate. Without prompt names a *new* note would be filed
    // under a generic folder and stay there, so it waits for a run where /prompts loads.
    const existing = ai.existingArtifacts.get(resp.id)
    if (!existing && !ai.promptsLoaded) {
      ai.index.set(resp.id, null)
      return false
    }
    const promptName = existing
      ? this.existingArtifactLink(existing, ai, resp.prompt_id).promptName
      : ai.promptNames.get(resp.prompt_id) || 'AI Response'
    const workspaces = await ai.loadWorkspaces()
    const wsName = (resp.workspace_id && workspaces.get(resp.workspace_id)) || ''
    let linkTarget: string
    if (existing) {
      linkTarget = existing.path.replace(/\.md$/i, '')
      ai.claimedArtifacts.set(linkTarget, resp.id)
    } else {
      const date = resp.created_at ? resp.created_at.slice(0, 10) : 'undated'
      const folder = normalizePath(
        `${this.root()}/${ARTIFACTS_DIR}/${sanitize(wsName || 'Unfiled')}/${sanitize(promptName)}`
      )
      const base = normalizePath(`${folder}/${sanitize(`${date}-${artifactSourceType(resp)}`)}`)
      linkTarget = await this.resolveArtifactNotePath(base, resp.id, ai.claimedArtifacts)
    }
    await this.upsertFile(`${linkTarget}.md`, this.buildArtifactNote(resp, promptName, wsName, body))
    ai.index.set(resp.id, { promptName, linkTarget })
    // Attribute this response to each of its source messages so those messages can link to it
    // even when their payload carries no ai_response_ids.
    for (const mid of resp.message_ids ?? []) {
      const set = ai.byMessage.get(mid) ?? new Set<string>()
      set.add(resp.id)
      ai.byMessage.set(mid, set)
    }
    return true
  }

  // Picks the artifact note path (no extension) for a response. It keeps the readable
  // <date>-<type> base unless a *different* response already owns that path — on disk (via the
  // note's cv_response_id) or claimed earlier this run — in which case a short response-id tag is
  // appended so two responses sharing a date + type + prompt + workspace never overwrite each other.
  // Identity is cv_response_id, so re-syncing the same response reuses its file in place. Mirrors
  // resolveMemoNotePath.
  private async resolveArtifactNotePath(
    base: string,
    responseId: string,
    claimed: Map<string, string>
  ): Promise<string> {
    const owner = claimed.get(base) ?? (await this.responseIdAt(`${base}.md`))
    let chosen = base
    if (owner != null && owner !== responseId) {
      const short = responseId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || responseId
      chosen = normalizePath(`${base} (${short})`)
      const tagOwner = claimed.get(chosen) ?? (await this.responseIdAt(`${chosen}.md`))
      if (tagOwner != null && tagOwner !== responseId) {
        chosen = normalizePath(`${base} (${responseId})`)
      }
    }
    claimed.set(chosen, responseId)
    return chosen
  }

  // The cv_response_id recorded in an artifact note's frontmatter, or null if no note (or no id)
  // lives at `path`. Cache-first; only reads the file on a genuine path collision.
  private async responseIdAt(path: string): Promise<string | null> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path))
    if (!(f instanceof TFile)) return null
    const cached: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.cv_response_id
    if (typeof cached === 'string') return cached
    const match = (await this.app.vault.read(f)).match(/^cv_response_id:\s*(\S+)/m)
    return match ? match[1] : null
  }

  // The note for one AI response: the rendered body plus links back to the source message(s). The
  // reverse links (message → artifact) come from the message notes, so Obsidian's backlinks pane
  // shows every referencing message here for free. Upserted (not create-if-absent) since a response
  // can be regenerated — re-syncing refreshes the body in place.
  private buildArtifactNote(
    resp: CarbonVoiceAiResponse,
    promptName: string,
    wsName: string,
    body: string
  ): string {
    const created = resp.created_at ? resp.created_at.slice(0, 10) : ''
    const messageIds = resp.message_ids ?? []
    const fm = [
      '---',
      `cv_response_id: ${resp.id}`,
      `cv_prompt_id: ${resp.prompt_id}`,
      `prompt_name: ${yaml(promptName)}`,
    ]
    if (wsName) fm.push(`workspace_name: ${yaml(wsName)}`)
    if (resp.workspace_id) fm.push(`workspace_id: ${resp.workspace_id}`)
    fm.push(`source_type: ${yaml(artifactSourceType(resp))}`)
    if (resp.channel_id) fm.push(`cv_conversation_id: ${resp.channel_id}`)
    // Source message ids: a plural list (a response can span several messages) plus a singular
    // `cv_message_id` for the common one-message case, so the artifact is queryable from either.
    if (messageIds.length) {
      fm.push(`cv_message_id: ${messageIds[0]}`)
      fm.push(`message_ids: [${messageIds.map(id => yaml(id)).join(', ')}]`)
    }
    if (created) fm.push(`date: ${created}`)
    fm.push('tags: [carbon-voice, ai-response]', '---', '')

    const lines = [`# ${promptName}`, '', body, '', '## Source']
    for (const id of messageIds) {
      lines.push(`- \`${id}\` — [Open in Carbon Voice ↗](https://carbonvoice.app/m/${id})`)
    }
    lines.push(`- **Synced:** ${formatDateTime(new Date().toISOString())}`, '')
    return fm.concat(lines).join('\n')
  }

  // ── Vault helpers ─────────────────────────────────────────────────────────

  private root(): string {
    return this.settings.syncFolder.trim() || 'Carbon Voice'
  }

  private windowToSince(window: HistoryWindow): string {
    if (window === 'all') return '1970-01-01T00:00:00.000Z'
    // 'none' means "skip this category" and is filtered out by callers before they reach here; guard
    // anyway so a stray call can't produce an invalid (NaN) date.
    if (window === 'none') return new Date().toISOString()
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
    if (this.settings.includeAiResponses) {
      await this.createIfAbsent(`${this.root()}/All AI Artifacts.base`, ARTIFACTS_BASE)
    }
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
  // URL has expired), fetches a fresh presigned URL via the v6 get-by-id endpoint.
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
      const fresh = await api.getMessage(m.message_id, { presigned_url: true, fresh: true })
      const url = fresh.content?.presigned_url ?? fresh.content?.url ?? null
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

// A wiki-link `[[target|alias]]` to an artifact. The alias is stripped of the `[`, `]` and `|`
// characters that would otherwise terminate the link early — a prompt name like "Q | A" must not
// break the message → artifact cross-link. The target path is already sanitized of those.
function artifactLink(target: string, alias: string): string {
  const safeAlias = alias.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim() || 'AI response'
  return `[[${target}|${safeAlias}]]`
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

// Whether a response is attached to a conversation message or a voice memo — voice memos have no
// channel. Drives the artifact filename and the note's `source_type` field.
function artifactSourceType(resp: CarbonVoiceAiResponse): string {
  return resp.channel_id ? 'conversation message' : 'voice memo'
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
