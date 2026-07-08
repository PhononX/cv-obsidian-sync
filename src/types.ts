export type SyncScope = 'all' | 'by_workspace' | 'by_conversation' | 'by_folder'
export type HistoryWindow = 7 | 30 | 90 | 365 | 'all'
export type MessageType = 'channel' | 'prerecorded' | 'voicememo' | 'stored' | 'welcome'
export type MessageKind = 'audio' | 'text' | 'attachment' | 'action-item' | 'ai-prompt' | 'ai-response' | 'channel-reminder'
export type MessageDirection = 'older' | 'newer'
export type ChannelType = 'directMessage' | 'customerConversation' | 'namedConversation' | 'asyncMeeting'
export type ChannelKind = 'standard' | 'derived'
export type WorkspaceType = 'standard' | 'webcontact' | 'personallink'
export type WorkspaceRole = 'admin' | 'owner' | 'creator' | 'member' | 'guest'

// ── API response shapes ─────────────────────────────────────────────────────

export interface CarbonVoiceIdentity {
  user_guid: string
  provider_email: string | null
  provider: string | null
  provider_uid: string | null
  image_url: string | null
  first_name: string | null
  last_name: string | null
  is_verified: string
  provider_phone: string | null
  last_message_notified: string | null
}

export interface CarbonVoiceUser {
  user_guid: string
  uuid: string
  first_name: string
  last_name: string
  email_txt: string
  image_url: string | null
  role: string
  workspace_guids: string[]
  identities: CarbonVoiceIdentity[]
}

// Messages (v3 — used by /v3/messages/recent)

export interface CarbonVoiceAudioModel {
  _id: string
  url: string
  extension: string | null
  streaming: boolean
  language: string
  duration_ms: number
  waveform_percentages: number[]
  is_original_audio: boolean
}

export interface CarbonVoiceTimecode {
  t: string // token/word text
  s: number // start ms
  e: number // end ms
}

export interface CarbonVoiceTextModel {
  type: string
  audio_id: string | null
  language_id: string
  value: string
  // For audio transcripts, `value` is empty and the words live here instead.
  timecodes?: CarbonVoiceTimecode[]
}

export interface CarbonVoiceAttachment {
  _id: string
  creator_id: string
  created_at: string
  type: string
  link: string
  filename: string | null
  mime_type: string | null
  length_in_bytes: number | null
}

export interface CarbonVoiceMessage {
  message_id: string
  creator_id: string
  created_at: string
  deleted_at: string | null
  last_updated_at: string
  workspace_ids: string[]
  channel_ids: string[]
  parent_message_id: string | null
  name: string | null
  is_text_message: boolean
  status: string | null
  type: MessageType | null
  folder_id: string | null
  duration_ms: number
  audio_models: CarbonVoiceAudioModel[]
  text_models: CarbonVoiceTextModel[]
  attachments: CarbonVoiceAttachment[]
  notes: string
}

// Messages (v5 — used by /v5/messages/{id}, richer shape)

export interface CarbonVoiceAudioInfo {
  url: string | null
  streaming_url: string | null
  duration_ms: number | null
  waveform_percentages: number[]
  presigned_url: string | null
  presigned_url_expiration_date: string | null
}

export interface CarbonVoiceAttachmentV5 {
  id: string
  creator_id: string
  created_at: string
  type: string
  url: string
  filename: string | null
  mime_type: string | null
  length_in_bytes: number | null
  presigned_url: string | null
  presigned_url_expiration_date: string | null
}

export interface CarbonVoiceMessageV5 {
  id: string
  type: MessageType
  kind: MessageKind
  created_at: string
  updated_at: string
  deleted_at: string | null
  conversation_id: string
  workspace_id: string
  creator_id: string
  status: string
  parent_message_id: string | null
  folder_id: string | null
  transcript: string | null
  ai_summary: string | null
  audio: CarbonVoiceAudioInfo | null
  attachments: CarbonVoiceAttachmentV5[]
  conversation_sequence: number | null
  source_message_id: string | null
  link: string
}

// Channels (conversations)

export interface CarbonVoiceChannelCollaborator {
  user_guid: string
  image_url: string
  first_name: string
  last_name: string
  permission: string
  joined: string | null
  last_posted: string | null
}

export interface CarbonVoiceChannel {
  workspace_guid: string
  channel_guid: string
  channel_name: string
  channel_kind: ChannelKind
  type: ChannelType
  channel_description: string | null
  image_url: string | null
  workspace_name: string
  sort_order: string | number | null
  last_updated_ts: number
  created_ts: number
  last_posted_ts: number | null
  deleted_at: number | null
  json_collaborators: CarbonVoiceChannelCollaborator[]
  total_messages: number
  total_duration_milliseconds: number
}

// Workspaces (v5)

export interface CarbonVoiceWorkspace {
  id: string
  name: string
  vanity_name: string | null
  description: string | null
  image_url: string | null
  type: WorkspaceType | null
  created_at: string
  last_updated_at: string
  owner_id: string | null
  creator_id: string | null
}

export interface GetWorkspacesResponse {
  results: CarbonVoiceWorkspace[]
  next_cursor: string | null
  has_more: boolean
  total: number | null
}

// Folders (voice memo / prerecorded)

export type FolderType = 'voicememo' | 'prerecorded'

export interface CarbonVoiceFolder {
  id: string
  name: string
  creator_id: string
  parent_folder_id: string | null
  subfolder_ids: string[]
  message_ids: string[]
  // Ordered list of ancestor folder IDs — immediate parent first, up to the root.
  path: string[]
  total_nested_folders_count: number
  total_nested_messages_count: number
  type: FolderType
  workspace_id: string
  created_at: string
  last_updated_at: string
  deleted_at: string | null
  subfolders?: CarbonVoiceFolder[]
}

export interface ListFoldersResponse {
  type: FolderType
  workspace_id?: string
  results: CarbonVoiceFolder[]
}

// ── Plugin settings ─────────────────────────────────────────────────────────

// Synthetic conversation-selection token: "sync every async-meeting conversation in this
// workspace". Stored alongside plain channel GUIDs in `conversationIds`, exactly like the
// `root:<workspace_id>` token used for voice-memo folders. The engine resolves it live so
// async meetings created after the rule was set are picked up automatically.
export const ASYNC_MEETING_PREFIX = 'asyncmeeting:'

export interface CarbonVoiceSettings {
  apiToken: string
  connectedUserId: string | null
  connectedUserName: string | null
  connectedUserAvatarUrl: string | null
  connectedIdentityEmails: string[]
  lastTokenValidated: string | null
  syncFolder: string
  syncInterval: number
  includeTranscripts: boolean
  // Cross-link notes: generate People/Workspace stub notes and link participants, senders and
  // workspaces so the Obsidian graph and backlinks connect everything.
  linkNotes: boolean
  // Download message audio into the vault so notes get a native, offline audio player. The
  // Carbon Voice audio URLs are presigned and expire, so durable playback requires a local copy.
  downloadAudio: boolean
  syncOnStartup: boolean
  lastSyncTimestamp: string | null

  conversationScope: SyncScope
  conversationWorkspaceIds: string[]
  conversationIds: string[]

  // channel_guid → channel type, populated lazily during sync so an async-meeting rule only
  // fetches each conversation once instead of on every run.
  channelTypeCache: Record<string, ChannelType>

  voiceMemoScope: SyncScope
  voiceMemoWorkspaceIds: string[]
  voiceMemoFolderIds: string[]

  conversationHistoryWindow: HistoryWindow
  voiceMemoHistoryWindow: HistoryWindow
}

export const DEFAULT_SETTINGS: CarbonVoiceSettings = {
  apiToken: '',
  connectedUserId: null,
  connectedUserName: null,
  connectedUserAvatarUrl: null,
  connectedIdentityEmails: [],
  lastTokenValidated: null,
  syncFolder: 'Carbon Voice',
  syncInterval: 15,
  includeTranscripts: true,
  linkNotes: true,
  downloadAudio: true,
  syncOnStartup: true,
  lastSyncTimestamp: null,

  conversationScope: 'all',
  conversationWorkspaceIds: [],
  conversationIds: [],
  channelTypeCache: {},

  voiceMemoScope: 'all',
  voiceMemoWorkspaceIds: [],
  voiceMemoFolderIds: [],

  conversationHistoryWindow: 30,
  voiceMemoHistoryWindow: 30,
}
