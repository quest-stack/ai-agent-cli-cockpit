# Cockpit build and signing boundaries

## Native file and localhost previews

The renderer now exposes previews through the existing right-hand layout when
the restricted native preview API is available. New work tabs start closed;
visibility, explicit dismissal, width and selection are remembered separately
from terminal state. The first detected localhost URL or verified artifact in
the active work tab opens an empty preview automatically. An explicit close is
remembered and prevents automatic reopening, including after reload. Existing
manually chosen or restored ordinary preview selections are never replaced by newly
detected artifacts. While following automatic selections, only generation/save
messages or standalone delivered artifact links may select a file; incidental
file references and read-tool output remain manual candidates. The latest
verified generated artifact (including PDF and images) is shown; older artifacts
from the same batch remain candidates rather than replacing it in reverse order. Choosing or
closing a target pins the selection; an explicit-choice flag is kept per tab in
localStorage so requested context documents stay selected after reload. Legacy
restored context documents without that flag remain available as tabs but may
yield to a newly generated artifact. Ordinary restored artifacts remain pinned.
Dismissal, inactive
tabs, comparison dialogs and the file chooser still prevent automatic display.
URL extraction waits for a complete token and a short quiet interval; ANSI
rendering and streamed ports cannot select a half-written URL. Automatic adds
are serialized so repeated CLI output cannot race to select multiple targets.
`preview.json` stores selected file/URL targets by work-tab ID. Closing a work
tab clears its preview targets without changing CLI preferences. No new package
dependency, workspace-schema migration, port scanner or CLI hook is required.

`PreviewManager` owns sandboxed `WebContentsView` instances with no preload or
Node integration. All terminal IPC checks the exact main-window WebContents,
top frame and expected document URL. General preview pages have a separate
in-memory session; only the built-in PDF viewer uses a dedicated persistent
partition because Electron 42 blocks its extension modules in in-memory
partitions. PDF uses an immutable temporary file with an exact URL grant, not
unrestricted file access. Neither partition shares the terminal renderer's API.

Local HTML and its relative assets are limited to the selected file's real
parent folder, with extension, traversal, hidden-file and symlink checks.
Markdown escapes raw HTML; SVG is displayed as an image. Remote assets are
blocked. HTTP(S) and WebSocket requests for a localhost preview stay on that
target's exact loopback origin; redirects, popups and arbitrary file navigation
are denied. Permissions remain denied except fullscreen for the active preview.

Selected files and actually requested assets are polled without scanning the
project tree. Two matching change observations precede updates. HTML/Markdown/
images update while visible; closed views retain an update flag until reopened.
PDF/MP4 require explicit application. Files are copied to immutable temporary
versions so the original can be regenerated; two recent versions are retained
and older unlocked cache files are removed. Videos pause and mute when hidden,
retain position on explicit replacement, and never automatically resume.

Initial limits are 20 targets per work tab, 10 MiB for HTML/Markdown, 100 MiB for
images and 512 MiB for PDF/MP4. Markdown supports headings, lists, tables, code,
emphasis and safe relative image/link syntax; it is not a full Markdown dialect.
PDF tab switching preserves the existing viewer; applying a new PDF does not yet
restore the viewer's page/zoom. Native Mac and packaged-app checks remain release
gates, separate from the Windows source-app verification.

`node scripts/run-preview-trial.mjs` launches the built native app with a new
temporary profile, no scan roots and no CLI sessions. It does not reuse or
modify the installed application's settings. See [scope](docs/PREVIEW_SCOPE.md).

### Responsive website checks

HTML and localhost targets offer Auto, Desktop (1440 x 900), Tablet
(768 x 1024), Phone (390 x 844), custom dimensions and orientation swapping.
Auto uses the pane's actual viewport. Fixed sizes keep the requested CSS
viewport and scale the presentation down to fit both dimensions without
enlarging it. Chromium's [device emulation API](https://www.electronjs.org/docs/latest/api/web-contents#contentsenabledeviceemulationparameters)
sets the view size and presentation scale; changing sizes does not reload the
document, and normal mouse input is mapped through the scaled view. Fullscreen
temporarily disables emulation and restores it on exit.

Sizes are bounded to integer 240..3840 CSS pixels in both dimensions and checked
at the IPC boundary. Target-specific sizes use a separately validated localStorage
record per work tab; existing preview targets and workspace settings need no
migration. Only web targets can enable emulation, so PDF, image and video controls
retain their original behavior. This checks Chromium viewport layouts, not
Safari rendering, touch behavior, mobile user agents or physical device metrics.

### Artifact discovery and visual comparison

HTML, localhost and Markdown comparisons now default to two saved, scrollable
complete pages. Electron's [MHTML save API](https://www.electronjs.org/docs/latest/api/web-contents#contentssavepagefullpath-savetype)
keeps loaded document resources with the old version. These are saved documents,
not two running application instances: archive scripts are not executed and
navigation, popups, downloads, permissions and network access are blocked.
The terminal API is never exposed to either archive view.

Automatic CLI-output discovery excludes project instructions and housekeeping
documents by case-insensitive filename: AGENTS (including .override), CLAUDE
(including .local), DESIGN, README (including language editions), SKILL,
CURRENT_STATUS and HANDOFF files. This filter runs before the extraction limit
and again at main-process resolution, so startup instructions cannot consume the
artifact candidate budget or trigger a missing-artifact warning. Normal generated
Markdown remains eligible. Explicit file/URL selection and existing saved targets
retain their behavior; reading instructions does not prevent manually previewing
them. Discovery does not infer file purpose from the document body or scan folders.

Submitted input from Cockpit may explicitly request checking, editing or displaying
a named context document. A bounded local input recognizer handles common Japanese
and English requests, quoted paths, paste framing and multiline submission. It
does not inspect CLI output for user intent. Negative requests, cancelled input and
cursor edits that cannot be reconstructed do not trigger a preview. Partial input
is held only in memory (4096 characters per session, at most 128 sessions) and is
cleared on submission or session exit; this recognizer does not log, persist or
send it to AI. The CLI's existing input delivery is unchanged.
Up to 16 opening requests are queued. The same session-cwd, realpath, hidden-file
and symlink checks apply before opening an existing requested document. It becomes
selected and can reopen a dismissed preview only in the active work tab. This
explicit opening does not remove the default startup exclusion or change normal
artifact discovery. Input submitted outside Cockpit, such as another shared-server
client, is not observed; manual file selection remains available. This is a local
heuristic, not a general natural-language understanding feature.

The first successful presentation of HTML, localhost or Markdown automatically
saves a comparison baseline after the native load/presentation finishes. The UI
identifies the automatic save. Later file reloads, in-place development-server
updates, resizing and reopening the preview keep that baseline. The comparison
button is then available without a manual baseline step; it does not open a
dialog automatically or infer a code-edit boundary from live DOM changes.
The user can replace the baseline with Save baseline. Baselines last for this
renderer session; app reload/restart establishes a new initial baseline.
Transient initial capture failures receive two bounded retries while the same
target is active. Automatic saves use the same ownership and isolation checks.

Markdown link destinations decode URL escapes, angle-bracket paths and local
file URLs before the existing cwd/realpath checks. Remote URLs and file hosts
receive no new grants. Raw quoted filesystem paths retain literal percent signs.
Completed OSC 8 hyperlinks retain their local destination even when the visible
label is only "View PDF". Generation progress and echoed shell commands do not
select artifacts. Japanese completion messages include writing/exporting files.

The pages use two isolated WebContentsViews at matching widths. They can be
scrolled independently. Text and selected computed styles including SVG
stroke/fill are matched by tag and signature occurrence, independently of sibling
indices. Each side's own selectors locate its changed elements. Absolute
coordinates and rendered dimensions are excluded, so inserted paragraphs,
wrapping and downstream reflow do not turn unchanged content into differences.
CSS Typed OM retains declared sizing and offsets (including auto/percent values)
instead of resolving ordinary flow boxes to used pixel dimensions. Actual CSS
width/height/offset changes are therefore marked without flagging all displaced
siblings. A longest ordered sequence of equal elements detects reorders while
keeping insertions and deletions local. This is an
element comparison, not a semantic document diff. Analysis is bounded to 5,000
elements. ASCII whitespace collapses only in normal rendered text; preformatted
spacing, line breaks, Japanese full-width spaces and non-breaking spaces remain
part of the comparison. Highlighting is limited to 500 selectors
per side. An unchanged image URL with replaced pixels may require Images mode.
Full direct text and SVG geometry attributes are hashed in the main process;
long paragraphs are not compared by a truncated prefix. DOM markup remains
limited to 10,485,760 characters and the UTF-8 metadata strings to 32 MiB total.
Archives are limited to 32 MiB each. Initial automatic capture, Save baseline
and Compare changes record up to three distinct versions per target. Ordinary
file saves and DOM updates do not create continuous background history. A
100 MiB per-instance history budget includes MHTML and PNG data; oldest versions
across targets are evicted when necessary. If the original baseline has been
evicted, comparison uses the most recent retained earlier version. If no older
complete page remains, the existing image fallback is used. Identical
archives/element metadata reuse the existing version: generated MIME dates,
boundaries and Blink resource IDs do not create duplicates. Changed embedded
resources still participate in the fingerprint. Deduplication also requires the
same capture viewport, scroll position and raster dimensions, so an unchanged
archive cannot substitute a screenshot from different display conditions.

Only the selected pair's PNGs are read into the comparison UI. Archive views are
created for the chosen two versions and destroyed when hidden, closed or changed.
Left/right selectors expose only version numbers and capture times. This is
temporary visual review within the running app, with no code diff, restore,
permanent version library, export, Git storage or external upload.

Preview caches live under the dedicated OS-temporary `cli-cockpit-preview-v1`
root. Each instance directory has a validated PID/nonce ownership marker.
Startup removes only known generated files from marked, dead instances; live
processes, unmarked legacy caches, unknown files and symlinks are preserved.
Normal disposal also attempts exact-file cleanup, and a later startup retries
crash/locked-file remnants. No recursive or broad temporary-folder deletion is
used. The history budget covers comparison data, not the live PDF/video caches.

Images mode retains the previous pixel comparison for all supported kinds.
For web captures, comparison temporarily restores the baseline CSS viewport so
changing the preview preset does not disable highlighting. Closing comparison
restores the user's selected preview size. PDF and images retain their prior
display-condition checks. If a full page cannot be saved, the UI explicitly
identifies the image fallback.

CLI text is parsed for a bounded list of supported artifact paths. Discovery
IPC checks tab/session ownership against the saved workspace and resolves only
from that session's recorded launch cwd. Existing files inside the real cwd are
returned as candidates; unsupported source extensions, hidden files and symlink
escapes are excluded. Unknown cwd, missing files and outside paths lead to the
manual picker. No filesystem scan, output logging or cwd guess is added.
The first verified artifact may fill an empty preview automatically; later
candidates remain selectable. Runtime directory changes inside a CLI are not observed.

Capture IPC accepts only the active target in its owning work tab, excludes
video, bounds scroll requests, and waits for paint with a timeout. It captures
the isolated guest view itself, not the terminal or desktop. PNGs are limited
to 1600 pixels on either side and 12 MiB, returned only to the trusted main
renderer. The current baseline and comparison are held in renderer memory;
historical PNGs stay in the bounded temporary store until selected or evicted.
Capture controls remain disabled until the selected revision finishes native
presentation. PDF capture waits within a bounded deadline for the built-in
viewer frame and completed load; an incomplete PDF cannot become a baseline.
Ready PDFs with unavailable page/zoom metadata retain side-by-side review with
highlighting disabled.
The native comparison dialog hides the live guest and makes the rest of the
renderer inert. Pixel captures remain in memory. The complete-page mode uses
the temporary archives described above. No AI, external upload, user-facing
disk export or dependency is involved.

RGBA differences above a small raster-noise threshold are grouped into nearby
16-pixel regions. Highlighting is available only when CSS viewport and root
scroll positions match; differently sized images can still be reviewed side
by side. The built-in PDF viewer's page/zoom are checked when available, and its
toolbar is excluded from highlighting. This uses the [Chromium viewer toolbar](https://chromium.googlesource.com/chromium/src.git/+/HEAD/chrome/browser/resources/pdf/pdf_viewer.html)
in the restricted extension frame. Missing or mismatched PDF page/zoom disables
highlighting and retains side-by-side review; navigation remains user-controlled.
Images mode compares the visible area, not the full document or semantic text.
Word text comparison is a separate requested follow-up.

## Retained browser-only UI trial

The next preview scope covers local HTML / development pages, Markdown, images,
PDF and MP4 video. The proposed UI adds a right-hand preview within each work
tab, with its own target tabs and a narrow-window AI / Preview switch. These
previews start closed for new work tabs and remember explicit visibility choices.
The native implementation opens on the first discovered artifact, but never
reopens after the user explicitly closes it. The browser-only sample retains
manual opening. Preview is shared by
Claude Code and Codex (including shared-server connections); PowerShell / Shell
also retains a manual entry point. The earlier fixed-sample browser UI trial
is still available through `node scripts/preview-prototype.mjs`
at `http://127.0.0.1:4174/?preview=prototype`. It is explicitly disabled whenever
the Electron preload API exists; native applications use the real file/URL
panel described above. The trial uses fixed, fictional sample targets and a separate browser
storage namespace; it never launches a real AI or reads generated user files.
The dev script generates its two-page PDF and H.264/AAC MP4 in an OS temporary
directory, serves only those two fixed sample endpoints, and supports video
range requests. MP4 fixture generation uses an optional existing local ffmpeg;
it installs no dependencies. HTML/Markdown/image samples are trusted React/SVG
content, not untrusted document renderers. See
[preview scope and interaction design](docs/PREVIEW_SCOPE.md), including update
rules, video playback, isolated rendering and open implementation questions.

## Launcher preference and explicit input cancellation

Preview button resets and hover styles are scoped to the preview toolbar and
region. The shared workspace also contains CLI controls; styling its descendant
buttons would override the launcher's primary action and other CLI buttons.

The launcher's three native radio controls are styled as buttons. Selection is
controlled by the existing persisted `settings.defaultCommand`; every launcher,
new tab and split reads that same value. Reopening a standard recent CLI updates
it too. Remote requests and restored sessions retain their own commands and do
not change the user's selection. Legacy PowerShell/Shell values are normalized
for the host platform without changing the workspace schema.

The pane's Cancel input button and Control+Shift+X (Command+Shift+X on Mac)
send exactly one ETX byte through the existing PTY input IPC. Key repeats and
IME composition do not trigger additional cancellation. The CLI decides how
to handle ETX: pending input may be cancelled and running work interrupted.
The existing Ctrl+C copy preference remains in effect. No process is killed
or restarted by this control, and it is disabled for closed/error sessions.

## macOS trial

The Mac trial reuses the renderer, workspace format and Electron IPC boundary.
`shell-launch.ts` selects an interactive login zsh/bash and adds common local
CLI locations for Finder/Dock launches. POSIX bootstrap commands preserve the
pane directory and Codex's existing opt-in behavior; Windows retains PowerShell,
UTF-8 initialization and ConPTY settings. No shell profiles or CLI settings change.
The legacy `powershell` workspace command remains readable; Mac launchers offer
`shell` for an empty terminal instead.

The sandboxed preload exposes only the host platform alongside the existing
restricted API. Mac app shortcuts use Command; Control+C remains terminal input
unless the existing user setting explicitly changes it, and Control+Tab stays
Control+Tab because Command+Tab belongs to macOS. Native Edit-menu clipboard
events and keyboard paste converge on one image-aware paste path. POSIX dropped
paths are single-quoted, including literal shell metacharacters.

Mac windows reserve room for native traffic lights and provide native app/edit/
window menus. As on Windows, closing the last window quits the app and its CLIs.
Mac trials skip the Windows-only public update manifest entirely. The Windows
release, version, manifest, app-data location and dependencies are unchanged.

`macos-trial.yml` runs on native Apple Silicon and Intel GitHub runners. It checks
types/lint/unit tests, rebuilds node-pty for Electron, tests real shell startup,
Command+V/native-menu image paste, pane restoration and opted-in Codex bootstrap,
then packages and repeats those checks in the packaged app. `build-macos-trial.mjs`
generates an ICNS icon from the committed ICO and builds Japanese DMG/ZIP packages
with `--publish never`. They use ad-hoc signing, without Developer ID credentials
or notarization. `collect-macos-trial.mjs` collects only packages, user guidance,
license/privacy documents, checksums and source metadata into CI artifacts.
There is no automatic GitHub release, signing-secret addition or public update.
The trial must still be checked with real Japanese IME and the actual AI CLIs on
the recipient's Mac; stub tests do not claim to cover those providers' behavior.

The native-preview suite also runs on both Mac architectures, before packaging
and against the packaged Japanese app through `COCKPIT_PACKAGED_EXECUTABLE`.
It checks the actual preview guest, sandbox boundaries, automatic baseline,
saved-page scrolling, element/SVG highlighting, bounded history and cleanup.
FFmpeg must be available so the unsupported-codec fixture is not silently skipped.
Windows CI includes the same source and packaged-app preview suite. These jobs
use the existing standard hosted runners; they do not publish a Release or
change billing settings. A configured job is not evidence that it has passed.

## Windows build

`.github/workflows/windows-build.yml` builds Japanese and English installers
on GitHub-hosted x64 and ARM64 Windows runners. Each target uses native Node.js
and the committed dependency lockfile, including node-pty's upstream Windows
prebuilds. Type checks, lint, unit tests, and the existing PowerShell / language
edition E2E checks must pass before collecting artifacts.
Shared Codex startup is tested through the real PowerShell PTY and again in the
packaged application on each native architecture before uploading installers.
Electron 42's lazy runtime download is performed in a separate setup step
before timed Playwright tests. The test timeout remains unchanged.
Edition packaging explicitly passes `--publish never` to electron-builder so
main-branch CI cannot trigger its implicit GitHub release publishing.

`scripts/collect-ci-artifacts.mjs` accepts only the runner's native Windows
architecture. It collects exactly the two expected installer names, checks
their executable headers, and writes SHA-256 checksums and source / run metadata.
Outputs are under the ignored `release/ci/<architecture>` directory. GitHub's
artifact ID and origin metadata, rather than the JSON file alone, will be the
source of SignPath provenance verification.

The workflow has read-only repository permissions, no persisted checkout
credentials, no signing secrets, and no release-publishing step. GitHub Actions
files use pinned upstream commits. Artifact retention is 14 days.

## SignPath preparation

The public policy documents clearly identify the current unsigned state.
Both language-edition packages include the policy and privacy documents under
`resources/docs`, so the bundled README's relative links have local targets.
Foundation acceptance and installation of its GitHub App are separate account
operations. Production signing will be added after onboarding, with explicit
human approval and verification of signed outputs. Signed hashes differ from
the unsigned build hashes and must be calculated after signing.

The NSIS installer includes upstream Electron / node-pty binaries. Signing the
outer installer does not also sign its payload or uninstaller. Confirm the
required signing phases and artifact configuration with SignPath before the
first production signed release.

## Privacy

The policy documents the existing automatic GitHub update request accurately;
it does not claim that all network access is user-initiated. Session content and
diagnostics are not automatically uploaded to the maintainer. Third-party CLI
processes have their own network behavior and data policies.

Signing preparation does not change saved settings, dependency versions,
the update manifest, or existing releases.

## Circled-number rendering

A circled number immediately followed by an ASCII space is joined for drawing
within its existing two cells. The terminal buffer, Unicode width rules, cursor
reports and copied text are unchanged. Compact circled numbers in DOM use the
existing Sarasa symbol font; WebGL rescales oversized one-cell glyphs to avoid
overlap. xterm excludes emoji from that rescaling. Joined numbers use the OS
symbol font, including Hiragino on Mac.
The Windows symbol face is normalized separately from the naturally wider Mac
face so joined glyphs stay within two cells on both platforms. Dingbats retain
Sarasa because xterm excludes that range from overlapping-glyph rescaling.
DOM spans use screen-grid measurements rather than xterm's shared character
measurement element, which can contain an arbitrary cached glyph. Tests cover
DOM/WebGL geometry, raster width, cursor reporting and copied text.
The Intel macOS hosted VM's WebGL fixture explicitly uses SwiftShader because
that VM has no hardware WebGL. This is limited to the trusted test process;
normal app launches retain the existing automatic DOM fallback.

## CLI activity detection

On Windows, standard Claude and independent Codex launches receive per-invocation
observational hooks. The PowerShell hook saves only validated lifecycle IDs and
event types locally, never stdin text, prompts, paths or transcripts. Atomic
files, session directories, ownership locks and bounded polling isolate sessions.
Hooks stay silent and never change approval, sandbox or trust settings; Codex's
own hook review remains required.

Active child IDs and in-flight tool-call IDs keep an otherwise idle terminal
busy. Direct Claude-to-Codex or Codex-to-Claude calls do not require a Subagent:
the caller's PreToolUse/PostToolUse lifecycle holds the indicator until the
call returns. IDs are scoped by session and agent so parallel calls cannot
clear each other. Claude additionally reports PostToolUseFailure and StopFailure;
Codex reports nonzero shell exits through PostToolUse. Only supported events
are configured for each provider. Tool IDs are validated and saved locally;
commands, arguments, outputs and error messages are never saved by this bridge.
The hook's storage root is inherited through a pane-local environment variable;
only a bounded relative path is repeated in the encoded hook command. Long
storage paths therefore cannot push the Codex .cmd launcher over cmd.exe's
command-line limit. The environment is not written to the OS or CLI settings.

Approval prompts take priority. A child's lifecycle cannot clear siblings or
the parent's tools. Stop, session end, a new turn and explicit Ctrl+C/Escape
input recover missing tool endings. Ctrl+C/Escape only release the tool
observation and return to output detection: the CLI decides what it interrupts,
and existing Subagent observations remain. Exit and disposal reject late events.
Queued hook files are read before an explicit Ctrl+C/Escape releases tool
observations, preventing a delayed poll from restoring an already observed call.
Detached background work whose launching tool has already returned is not
covered unless its CLI reports the running call through completion (such as
Codex unified-exec polling). No process existence or transcript scraping is
used to infer completion. Output heuristics remain the fallback
when hooks are disabled, untrusted or unavailable. Mac does not run PowerShell
hooks. Shared Codex also keeps output detection: its existing daemon owns server
configuration, and client overrides are not assumed to reconfigure that daemon.
Shared startup and phone opt-in are preserved.

## Codex shared-server startup

For the standard `codex` session command, Cockpit reads the existing boolean
`remoteControlEnabled` from the user's Codex managed-daemon settings. An explicit
true value selects shared startup; missing, disabled or malformed settings retain
the existing independent CLI startup. Cockpit does not enable remote access,
create pairings, read credentials, or write Codex configuration.

Shared startup first starts the existing managed daemon, then runs the terminal
client with `--remote unix://` and the pane's explicit current directory. A failed
daemon start leaves an actionable error in the shell and does not fall back to an
independent writer. This selection happens for new or restarted panes; existing
processes are not migrated or interrupted. Claude, PowerShell and custom commands
retain their existing startup behavior.
