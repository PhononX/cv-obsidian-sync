import { requestUrl } from 'obsidian'
import type {
  CarbonVoiceUser,
  CarbonVoiceMessage,
  CarbonVoiceMessageV5,
  CarbonVoiceMessageRecentV5,
  CarbonVoiceAiResponse,
  CarbonVoicePrompt,
  CarbonVoiceAudioModel,
  CarbonVoiceTextModel,
  CarbonVoiceAttachment,
  CarbonVoiceChannel,
  GetWorkspacesResponse,
  CarbonVoiceFolder,
  ListFoldersResponse,
  FolderType,
  MessageDirection,
  WorkspaceType,
  WorkspaceRole,
} from './types'

const BASE_URL = 'https://api.carbonvoice.app'

export interface MessageQueryParams {
  date: string
  direction: MessageDirection
  use_last_updated: boolean
  channel_id?: string
  limit?: number
}

export interface RecentChannelsFilter {
  limit?: number
  direction?: MessageDirection
  date?: string
  includeDeleted?: boolean
}

export interface GetMessageOptions {
  language?: string
  presigned_url?: boolean
  fresh?: boolean
}

export interface WorkspaceQueryParams {
  direction?: MessageDirection
  limit?: number
  date?: string
  starting_after?: string
  ending_before?: string
  roles?: WorkspaceRole[]
  types?: WorkspaceType[]
  include_total?: boolean
}

export interface FolderQueryParams {
  type: FolderType
  include_all_tree?: boolean
  workspace_id?: string
  sort_direction?: 'ASC' | 'DESC'
  sort_by?: string
}

export class CarbonVoiceAPI {
  constructor(private token: string) {}

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  // Single request path so every failure names the endpoint that produced it. `throw: false` keeps
  // Obsidian from raising a bare "Request failed, status N" before we can attach the method + path,
  // which is otherwise impossible to trace across a large import. On error we also log the response
  // body to the developer console (Ctrl/Cmd+Shift+I) — it usually explains *why* (e.g. a 403).
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await requestUrl({
      url: `${BASE_URL}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      throw: false,
    })
    if (res.status === 401) throw new Error(`Invalid API token (${method} ${path})`)
    if (res.status < 200 || res.status >= 300) {
      console.error(`Carbon Voice API error ${res.status} on ${method} ${path}`, res.text)
      throw new Error(`API error ${res.status} on ${method} ${path}`)
    }
    return res.json as T
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  async getWorkspaces(params: WorkspaceQueryParams = {}): Promise<GetWorkspacesResponse> {
    const qs = new URLSearchParams()
    if (params.direction) qs.set('direction', params.direction)
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.date) qs.set('date', params.date)
    if (params.starting_after) qs.set('starting_after', params.starting_after)
    if (params.ending_before) qs.set('ending_before', params.ending_before)
    if (params.roles) params.roles.forEach(r => qs.append('roles', r))
    if (params.types) params.types.forEach(t => qs.append('types', t))
    if (params.include_total) qs.set('include_total', 'true')
    const query = qs.toString() ? `?${qs.toString()}` : ''
    return this.get<GetWorkspacesResponse>(`/v5/workspaces${query}`)
  }

  // ── Folders ───────────────────────────────────────────────────────────────

  // Root folders for a given type. Pass include_all_tree to get the full nested tree in one
  // call; subfolders are then available via each folder's `subfolders` / `path`.
  async getFolders(params: FolderQueryParams): Promise<CarbonVoiceFolder[]> {
    const qs = new URLSearchParams()
    qs.set('type', params.type)
    if (params.include_all_tree) qs.set('include_all_tree', 'true')
    if (params.workspace_id) qs.set('workspace_id', params.workspace_id)
    if (params.sort_direction) qs.set('sort_direction', params.sort_direction)
    if (params.sort_by) qs.set('sort_by', params.sort_by)
    const data = await this.get<ListFoldersResponse>(`/folders?${qs.toString()}`)
    return data.results
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async getCurrentUser(): Promise<CarbonVoiceUser> {
    const data = await this.get<{ success: boolean; user: CarbonVoiceUser }>('/whoami')
    return data.user
  }

  // ── Channels (Conversations) ──────────────────────────────────────────────

  // Returns channels ordered by recent activity. Omit filter to get all.
  async getRecentChannels(filter: RecentChannelsFilter = {}): Promise<CarbonVoiceChannel[]> {
    return this.post<CarbonVoiceChannel[]>('/channels/recent', filter)
  }

  // V2 includes all collaborators in json_collaborators.
  async getChannel(channelGuid: string): Promise<CarbonVoiceChannel> {
    return this.get<CarbonVoiceChannel>(`/v2/channel/${channelGuid}`)
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  // Returns messages across all channels (or one channel via channel_id).
  // Voice memos have type === 'voicememo' and a folder_id.
  //
  // Backed by POST /v5/messages/recent — a lighter payload than the old v3 endpoint that also
  // reports each message's AI responses (ai_response_ids). The v5 shape differs (single-valued
  // conversation_id/workspace_id, direct transcript/ai_summary, a single audio object), so we
  // normalise every row back into the CarbonVoiceMessage the sync engine consumes; the mapped
  // message additionally carries `ai_response_ids`.
  async getRecentMessages(params: MessageQueryParams): Promise<CarbonVoiceMessage[]> {
    const body = {
      date: params.date,
      direction: params.direction,
      use_last_updated: params.use_last_updated,
      ...(params.limit != null ? { limit: params.limit } : {}),
      // v5 names the conversation filter `conversation_id` where v3 used `channel_id`.
      ...(params.channel_id ? { conversation_id: params.channel_id } : {}),
    }
    const rows = await this.post<CarbonVoiceMessageRecentV5[]>('/v5/messages/recent', body)
    return rows.map(mapRecentV5ToMessage)
  }

  // ── AI responses & prompts ────────────────────────────────────────────────

  // The AI responses generated for a message (one call per id from a message's ai_response_ids).
  async getResponse(id: string): Promise<CarbonVoiceAiResponse> {
    return this.get<CarbonVoiceAiResponse>(`/responses/${id}`)
  }

  // All prompts the account can see, used to label a response by the prompt that produced it.
  async getPrompts(): Promise<CarbonVoicePrompt[]> {
    return this.get<CarbonVoicePrompt[]>('/prompts')
  }

  // Downloads a binary asset (e.g. message audio) by URL. No Authorization header: the Carbon
  // Voice audio URLs are presigned S3 links, and S3 rejects requests that carry both a
  // query-string signature and a bearer token ("only one auth mechanism allowed").
  async downloadBinary(url: string): Promise<ArrayBuffer> {
    const res = await requestUrl({ url, method: 'GET' })
    if (res.status < 200 || res.status >= 300) throw new Error(`Download failed ${res.status}`)
    return res.arrayBuffer
  }

  // V5 has transcript and ai_summary as direct fields — prefer this for sync.
  async getMessage(id: string, options: GetMessageOptions = {}): Promise<CarbonVoiceMessageV5> {
    const params = new URLSearchParams()
    if (options.language) params.set('language', options.language)
    if (options.presigned_url) params.set('presigned_url', 'true')
    if (options.fresh) params.set('fresh', 'true')
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await this.get<{ message: CarbonVoiceMessageV5 }>(`/v5/messages/${id}${qs}`)
    return data.message
  }
}

// Normalises a /v5/messages/recent row into the CarbonVoiceMessage the sync engine consumes. The
// v5 payload is flatter: transcript and ai_summary are direct strings (re-expressed here as the
// `transcript` / `summary` text models the engine reads), audio is a single object (re-expressed
// as a one-entry audio_models list), and scope is single-valued (wrapped back into arrays). When
// the payload omits `name` (not in the documented recent shape) a memo's title falls back to its
// summary/transcript. The message's `ai_response_ids` are preserved for AI-response sync.
function mapRecentV5ToMessage(r: CarbonVoiceMessageRecentV5): CarbonVoiceMessage {
  const language = r.language ?? ''

  // Prefer the direct transcript string; fall back to joining the per-word time codes (audio
  // messages can carry the words there with an empty top-level transcript), matching v3 handling.
  const transcript =
    r.transcript?.trim() ||
    (r.time_codes ?? [])
      .map(tc => tc.t)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

  const textModels: CarbonVoiceTextModel[] = []
  if (transcript) {
    textModels.push({ type: 'transcript', audio_id: null, language_id: language, value: transcript })
  }
  if (r.ai_summary && r.ai_summary.trim()) {
    textModels.push({ type: 'summary', audio_id: null, language_id: language, value: r.ai_summary })
  }

  const audioModels: CarbonVoiceAudioModel[] = []
  const audioUrl = r.audio?.presigned_url || r.audio?.url || r.audio?.streaming_url || ''
  if (audioUrl) {
    audioModels.push({
      _id: r.id,
      url: audioUrl,
      extension: null,
      streaming: false,
      language,
      duration_ms: r.audio?.duration_ms ?? 0,
      waveform_percentages: r.audio?.waveform_percentages ?? [],
      is_original_audio: true,
    })
  }

  const attachments: CarbonVoiceAttachment[] = (r.attachments ?? []).map(a => ({
    _id: a.id,
    creator_id: a.creator_id,
    created_at: a.created_at,
    type: a.type,
    link: a.url,
    filename: a.filename,
    mime_type: a.mime_type,
    length_in_bytes: a.length_in_bytes,
  }))

  return {
    message_id: r.id,
    creator_id: r.creator_id,
    created_at: r.created_at,
    deleted_at: r.deleted_at,
    last_updated_at: r.updated_at || r.created_at,
    workspace_ids: r.workspace_id ? [r.workspace_id] : [],
    channel_ids: r.conversation_id ? [r.conversation_id] : [],
    parent_message_id: r.parent_message_id,
    name: r.name ?? null,
    // Only an `audio` kind is an audio message; everything else (text, ai-*, action items…) is
    // rendered as text so it never shows a phantom duration or audio player.
    is_text_message: r.kind !== 'audio',
    status: r.status,
    type: r.type,
    folder_id: r.folder_id,
    duration_ms: r.audio?.duration_ms ?? 0,
    audio_models: audioModels,
    text_models: textModels,
    attachments,
    notes: '',
    ai_response_ids: r.ai_response_ids ?? [],
  }
}
