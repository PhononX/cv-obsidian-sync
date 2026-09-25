# Carbon Voice Sync

Sync your [Carbon Voice](https://getcarbon.app) conversations and voice memos
into your Obsidian vault as Markdown notes.

> **Desktop and mobile.** The plugin talks to the Carbon Voice API over the
> network and runs on both Obsidian desktop and mobile.

## Use cases

- **Async meeting notes in your vault.** Just as people pull meeting recordings
  and transcriptions into Obsidian, this brings your Carbon Voice async
  conversations in automatically — so the discussion, decisions, and transcripts
  live alongside the rest of your notes and are there to refer back to later.
- **Feed your second brain by voice.** Drop a quick thought into a Carbon Voice
  voice memo and it gets transcribed and synced into Obsidian on its own — no
  typing, no copy-paste. Capture ideas the moment they happen and let them flow
  straight into your knowledge base.

## Features

- **Connect your Carbon Voice account** with a Personal Access Token — the token
  is stored locally in your vault and only ever sent to the Carbon Voice API.
- **Choose what syncs:**
  - _Conversations_ — all of them, only those in selected workspaces, or a
    hand-picked set of conversations.
  - _Voice memos_ — all of them, only those in selected workspaces, or specific
    folders.
- **Import history** per category, with a configurable window (last 7 / 30 / 90 /
  365 days, or all time).
- **Background sync** on a configurable interval, and optional sync on startup.
- **Optional transcripts** — include or omit message transcripts in your notes.
- **Linked knowledge graph** — participants, message senders and workspaces become
  `[[wiki links]]` to auto-generated **People** and **Workspace** notes, so the
  Obsidian graph and backlinks connect every conversation and memo. Those stub notes
  are created once and never overwritten, so you can annotate them freely.
- **AI summaries** — a voice memo's Carbon Voice summary is written into a `## Summary`
  section at the top of its note.
- **AI artifacts** — AI outputs (summaries, action items and other prompt responses) sync into an
  **AI artifacts** folder, organised as `AI artifacts/<workspace>/<prompt>/`, one note per response
  named `<date>-<voice memo | conversation message>`. Each message links out to its artifacts, and
  every artifact backlinks to the message(s) it came from — so a response shared across messages is
  one note, reachable from all of them. An "All AI Artifacts" Base lists them in one place. Toggle
  off with the **Sync AI artifacts** setting, or pull past ones with the separate **Import AI
  artifacts** action (its own time window) under Historical import.
- **Audio playback in your notes** — listen right next to the transcript. Choose how:
  - _Embed player_ (default) — inline Carbon Voice player, nothing stored in your vault;
    private messages show their own locked state.
  - _Download for offline_ — save each message's audio into a `Media` folder and embed a
    native player, so playback works offline (and for private audio).
  - _Off_ — no player, just the "Open in Carbon Voice" link.

> **Status:** `0.7.0` — listed in the Obsidian community plugin store. Account
> connection, all sync configuration (scopes, folders, workspaces, history
> windows), forward sync, historical import, and AI artifact sync are functional.
> Still pre-1.0, so the note format and settings may change between versions —
> consider a test vault or a backup if that matters to you.

## Installation

The plugin is in the Obsidian community plugin directory:
**[Carbon Voice Sync](https://community.obsidian.md/plugins/carbon-voice-sync)**.

From inside Obsidian, open **Settings → Community plugins → Browse**, search for
**Carbon Voice Sync**, then **Install** and **Enable**. Opening
`obsidian://show-plugin?id=carbon-voice-sync` jumps straight to it in the app.

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/phononx/cv-obsidian-sync/releases).
2. Create a folder named `carbon-voice-sync` in your vault's
   `.obsidian/plugins/` directory.
3. Copy the three files into that folder.
4. Reload Obsidian and enable **Carbon Voice Sync** under Community plugins.

## Setup

1. Generate a **Personal Access Token** in the Carbon Voice app: open the
   **Profile** menu, select **Integrations → Integration Credentials**, and
   create a token.
2. In Obsidian, open **Settings → Carbon Voice Sync** and click **Add token**.
3. Paste your token and click **Connect**. Once validated, your account name and
   email appear at the top of the settings.
4. Configure your **sync folder**, **interval**, and the **conversation** and
   **voice memo** scopes to control exactly what gets pulled into your vault.

## Development

Requires Node.js 20+.

```bash
npm install      # install dependencies
npm run dev      # rebuild main.js on change (esbuild watch)
npm run build    # production build
```

The build bundles `src/main.ts` into `main.js` at the repo root. `main.js` is
git-ignored — it is produced by the build and attached to GitHub releases rather
than committed.

## Releasing

Releases are automated by `.github/workflows/release.yml`. To cut one:

```bash
npm version <patch|minor|major>   # bumps package.json, manifest.json, versions.json
git push --follow-tags            # pushes the branch and the version tag
gh release edit <version> --draft=false --latest   # publish the draft
```

Pushing the tag triggers a build and creates a **draft** GitHub release with
`main.js`, `manifest.json`, and `styles.css` attached as assets.

**The third step is not optional.** A draft is invisible to the Obsidian
updater and to anyone downloading manually — both resolve the latest
*published* release, so until you publish, the previous version is still what
everyone gets. Publish from the
[releases page](https://github.com/phononx/cv-obsidian-sync/releases) or with
the `gh` command above.

Once published, the update reaches users on its own: because the plugin is
listed in the community store, Obsidian reads new versions directly from this
repo's releases. No pull request to `obsidianmd/obsidian-releases` is needed for
a version bump — that is only for changing the listing's name, author,
description, or repo in `community-plugins.json`.

The `npm version` step keeps `manifest.json` and `versions.json` in sync with
the tag, and `.npmrc` sets `tag-version-prefix=""` so the tag has no `v` prefix
— the release name then always matches the plugin version exactly, as Obsidian
requires. The workflow fails fast if the tag and manifest version disagree.
`versions.json` maps each plugin version to its `minAppVersion`, so users on an
older Obsidian are offered the newest version they can actually run.

## License

[MIT](LICENSE) © Phonon X, Inc.
