# TurnStage Web user guide

This guide covers operating TurnStage Web, managing cases, and backing up data.
Deployers should read [Web deployment](web-deployment.md); for the extension, see the
[VS Code user guide](vscode-user-guide.md). Full specifications and development
information are in the [documentation index](README.md).

This is an English translation of the Traditional Chinese
[Web user guide](web-user-guide.md). If the two ever differ, the Chinese guide is the
reference.

## Get started

1. Open TurnStage Web at the address your organization provides (for example an
   internal `http://SERVER_IP:9095/`). To preview an extracted Web archive on your own
   machine, follow the
   [local preview steps in Web deployment](web-deployment.md#preview-the-extracted-archive-locally).
   Do not open `index.html` through `file://`. Over plain HTTP, traffic and plaintext
   credentials are not encrypted; see the
   [HTTP deployment notes](web-deployment.md#serve-by-ip-over-ordinary-http).
2. Pick a Profile in the left list. With many Profiles, search by name, ID, default
   category, or tag, and filter by All / Default / Local. On narrow screens, tap the
   search icon to expand the sidebar.
3. Check the connection status at the top of the view.
4. Send a test message that contains no sensitive data.
5. Use the **Debug**, **General tests**, or **Red Team** tabs to inspect requests,
   events, results, and evidence.

By default the browser connects directly to the API named in the Profile. If the
deployer runs the bundled `serve.py` with `--upstream`, only requests to `/api/` under
the same Web address are forwarded by the Web server to that fixed upstream. Requests to
any other host or port still go straight from the browser and must satisfy the
browser's network, TLS, and CORS rules.

When a reply maps to Markdown, TurnStage shows the Markdown and safe static HTML
together by default. To turn either off, set `markdown` or `html` to `false` under
`ui.responseContent` in the Profile; when omitted, both are on. Wide tables scroll
horizontally inside the reply, and images shrink to the available width. Click an
assistant reply to open a full-screen **Preview** and a **Raw content** view assembled
from the events, copy the raw text, or jump to related events. If backend HTML uses
classes, `classStyles` sets base styles and `styleRules` sets descendant, child,
sibling, and hover/focus rules for those classes; rules apply only to that reply.
Selectors and CSS outside the allowed set, `url()`, JavaScript, event handlers, and
embedded content do not run. See the
[Profile schema](profile-schema.md#assistant-response-content) for examples and limits.

## Layout and narrow screens

In a wide workspace, chat appears beside **Debug / General tests / Red Team /
Configure**. At a workspace width of 1,024px or less, **Chat** becomes the first tab.
The width is measured after subtracting the left list, so a browser about 1,100px wide
may also use the tabbed layout.

Switching tabs keeps your draft, streaming reply, scroll position, expanded state, and
filters, and a reload returns to the side you were on. In chat, the inspect icon on a
message goes to **Debug** and the gear opens **Configure**. At very narrow widths the
Chat tab shows only an icon. Tabs support the arrow keys, Home, and End; Tab follows the
on-screen control order. Web keeps its amber look; switch light or dark under
**Language and appearance** at the bottom left.

## Where a Profile comes from

Every Profile in the left list shows its source:

- **Default Profile**: provided by your organization's Catalog. Everyone sees the same
  current version, and it cannot be overwritten directly.
- **Browser-local**: stored only in this browser and this site origin. You can edit or
  delete it.
- **Browser-local · based on a default Profile**: copied or modified from a default
  Profile. A local copy is never overwritten when the default Profile is updated.

If a default Profile gets a newer version after you copied it, TurnStage Web shows a
notice next to your local copy. Compare and decide whether to copy the new version; the
system never merges or overwrites your local content automatically.

### Organize Profile folders

Nested folders under the server's `profiles/` directory appear in the **Default** list;
the deployer manages them on the server. Add your own folders with the folder icon
next to the list title. A folder offers add subfolder, move up or down, rename, and
delete. To file a local Profile, open its **⋯** menu and choose **Move to folder**.
Deleting your own folder asks for confirmation, and the Profiles and subfolders inside
move up one level; no Profile is deleted. While you search, matching Profiles are shown
even when their folder is collapsed. Personal folders and filing live only in this
browser; they do not change the server's default Profiles and are not part of a portable
Profile export.

## Create and change Profiles

### View and edit JSONC

From a Profile's **⋯** menu, choose **Edit JSONC** to change a browser-local Profile
directly, with settings sections, search, line numbers, and syntax highlighting, and
with comments preserved. Press **Save** when done. If the format or Profile validation
fails, the original content is not replaced, and leaving with unsaved changes asks for
confirmation. A server-provided default Profile shows **View JSONC** in the same place:
you can search, jump to a section, copy, or download, but it stays read-only. To change
it, choose **Duplicate to edit** to make a local copy first. The right-hand **Configure**
tab can also open the current Profile's JSONC. To share a Profile together with its
connection environment, use **Export** from the left list.

The URL can select a Profile with `?profile=<profile ID>`, for example
`http://server:9095/?profile=basic-sse-chat`. The URL updates when you switch Profiles,
and other query parameters and the fragment are preserved. If the ID does not exist in
this browser, Web falls back to the last selected or the default Profile and updates the
URL to the one actually opened. A local Profile exists only in the browser that created
it, so sharing the URL does not share its content.

**Profile guide** at the bottom left opens on its own. It points to where settings live
and gives copyable snippets for requests, timeouts, controls, openings, stream events,
and test cases. Snippets are partial examples to add to the matching place in an
existing Profile; for complete fields and advanced settings, see the
[Profile schema](profile-schema.md).

The **⋯** menu in the Profile list also offers view or edit JSONC, copy, export, and
delete for a local Profile. Once you have created a custom folder, it also shows
**Move to folder**. Default Profiles follow the server's folders and cannot be moved to
a local folder or deleted. With the keyboard, focus the row to reveal its actions and
press Escape to close the menu.

### Use an official template

You can run tests directly on an official template. Its configuration controls are
disabled and the screen tells you to choose **Duplicate to edit** (or **Duplicate** in the left
list) first. Only after the copy is made does Web switch to the editable browser-local
copy. TurnStage Web never creates a copy silently just because you touched a field, and
the official template stays unchanged.

### Add a blank Profile

Use the **New profile** button next to the left list title. The new Profile contains a
request and stream skeleton that passes basic validation; then change the name, request,
and event mapping in **Configure**.

### Copy a Profile

Select a Profile and choose **Duplicate**. The copy gets a unique ID such as
`basic-sse-chat-copy` or `basic-sse-chat-copy-2`.

### Import a Profile

1. Choose **Import profile** next to the left list title.
2. Select a `*.turnstage-profile.json` or `*.turnstage-profile-and-cases.json` file
   exported by TurnStage Web. Both contain the Profile, its environment, and any token
   or similar values written directly into them; the latter also contains the test
   suites imported in the browser.
3. If a Profile or Environment ID already exists, TurnStage Web generates unique local
   IDs for both and fixes the Profile's Environment reference. Existing data is never
   overwritten.
4. A legacy single `.json` or `.jsonc` Profile can still be imported, but it does not
   include its connection environment. If the browser lacks that environment, use a
   portable file that includes it, or ask the deployer for an official Profile.
5. After importing, check the target URL, headers, request body, and event mapping before
   running tests.

Treat imported files as untrusted configuration. Do not import files from unknown
sources. A portable file can contain plaintext tokens, cookies, passwords, or API keys,
so confirm who shared it and which URL it targets before importing.

### Export a Profile

A Profile's **⋯** menu offers two exports. **Export** produces a
`*.turnstage-profile.json` with only the Profile and its environment. **Export profile
and cases** also includes the test suites you imported in the browser for this Profile
and produces a `*.turnstage-profile-and-cases.json`. Cases embedded in the Profile are
in both. Neither file contains run logs or detailed evidence, and `${secret.*}` values
held in page memory are not exported. The recipient chooses **Import profile**; import
creates a new local Profile and never overwrites data with the same ID. Before sharing,
check the URLs, credentials, and test inputs inside.

### Delete or reset

- A local Profile can be removed with **Delete**.
- An official Profile cannot be deleted.
- If a local Profile uses the same ID as an official one, deleting the local item shows
  the current official version again.

There is no server-side recycle bin after browser data is deleted. Export important
Profiles first as a backup.

## Connection environments and secrets

The left list shows only Profiles; connection environments are not listed or edited
separately. A Profile reads environment values through `${env.name}`. Official
environments are maintained by the deployer in the server templates. A portable Profile
is imported or exported together with the environment it references and never changes the
official version.

- A Profile or its environment can contain shared plaintext tokens, cookies, passwords,
  or API keys. They are kept in `localStorage` and are included in portable exports.
- A Profile uses `${secret.name}` for a session secret that is not shared and is typed in
  by the current user only.
- An Environment's `secretReferences` describe secret names only; they never store secret
  values.
- A secret value stays only in the current page's memory. After a reload or closing the
  page you must enter it again.

Write a credential directly into a Profile, Environment, or organization Catalog only
when every recipient is supposed to receive the same credential. Portable files and the
Catalog are not encrypted; anyone who can read the file or the site's static content can
see the plaintext. Do not put credentials into test cases, CSV files, reports, or
screenshots.

A Profile's drop-down controls can keep the old string options, or let one option carry
several string fields, for example `"value": { "customerId": "C001", "regionCode":
"R001" }`. Reference the fields in `conversation.send.variants[].body` with
`{ "$value": "controls.user.customerId" }` and `{ "$value": "controls.user.regionCode" }`.
To expand the controls by default, add `"ui": { "components": { "controls":
{ "defaultCollapsed": false } } }` to the Profile; when unset they stay collapsed.
Switching users does not reset the backend conversation ID automatically. If the
backend identifies conversations by user, start a new conversation after switching.

## Conversation drawer and server history

The **Conversations** button in the chat toolbar opens the list of saved conversations,
where you can search, switch, or delete items. Escape closes it and returns focus to the
button that opened it. When conversation saving is on, starting a new conversation no
longer asks for a destructive restart confirmation.

A Profile's `conversations.list` and `conversations.history` describe the server's list
and message endpoints, and `history.conversations` controls local saving. With
`verifyAfterTurn` on, each completed reply is compared with the server history and the
toolbar shows a match or a difference count. A difference is a diagnostic result; it
never silently overwrites the current reply. Try the **Server rewrites saved answer**
mock scenario in Basic SSE Chat to see a difference. The endpoint still has to satisfy
the browser's TLS and CORS rules.

Saved items, per-turn replay records, and test run summaries serve different purposes.
A portable Profile file does not share these conversations or evidence. For the field
definitions, see
[conversation history](profile-schema.md#conversation-drawer-and-history).

## Tests, red-team cases, and run history

### Case list and latest results

Each case shows its latest result and duration; one that has never run shows **Not run**,
and one in progress shows live status. The **Last run** summary counts each current
case's latest history result. General tests offer All / Failed / Not run, where Failed
includes failures and errors. The red-team summary and filter use Resisted / Not
resisted, while case badges still keep the four outcomes: Resisted, Attack succeeded,
Indeterminate, and Infrastructure error.

The summary's rerun button runs only the cases the summary counts as not passing, and
**Run history** opens the history for that test type. Filters are kept when you switch
to the other test type and back; clearing that type's history returns the case list to
All. No second completion card appears after a run finishes.

### Import, run, and reports

Choose **General tests** or **Red Team** on the right, then **Test cases** or **Test
results**; the two kinds of case are judged differently and are never mixed in one list.
In both you can search, select, run, and edit in the existing case list, and adding,
importing, and linking stay on the same screen. The list shows 25 items per page. You can
run a single case, tick cases, or select every runnable case of that type that matches
the search. There is no fixed case limit; what can be processed depends on browser
storage and the user's device. Running cases still sends requests to the target service
named in the Profile, and before it starts the screen shows the number of cases,
attempts, and maximum requests. Cases with unfilled required fields, drafts awaiting
review, and cases that Web does not support cannot be selected or run. Results can be
searched and paged and contain this run's detail plus a summary history that survives a
reload. A completed record can be set as the comparison baseline. Detailed evidence can
expire separately, so do not treat the summary history as a permanent evidence backup.
Imported suites are browser copies and do not change the original files; if the original
is updated outside, import it again. Use the buttons on screen to import or export JSON,
JSONC, JSONL, CSV, HTML, JUnit, or ZIP files.

Exporting HTML from each **Test results** view gives an offline detailed report: a
result and performance summary, TTFT and total time P50 and P95, distribution charts, and
for every case its steps, expected and actual values, conversation, request and response,
raw and normalized events, and errors. The report supports search, result filters, a
non-passing-only view, paging, expand and collapse, and full printing; exporting from a
run history entry includes only that run and the chosen test type. The report contacts no
external service, and its embedded script is limited by a Content Security Policy.
Sensitive headers and recognized secret fields are masked, but conversations and payloads
can still contain confidential data, so store and share them according to your data
classification policy. If detailed evidence has expired, run again before exporting, and
do not mix an old record with other runs in one report.

Both **Test cases** headings have a **Download sample CSV** button. General and red-team
tests download different formats, and each example contains real cases you can import
again.

On the Web, **Import** copies a test suite into this site's IndexedDB; later edits change
only the browser copy and never the original file on your computer. If the original is
updated externally, import it again. A suite with the same ID asks whether to update it
first and never creates duplicate cases. If you need to keep workspace files linked,
refresh from disk, or open the original in an editor, use the VSIX. Network-fault
simulation, environment comparison, and performance regression checks against a VS Code
baseline also need the VSIX; Web supports absolute time-threshold checks.

During a run you can **Pause test run**: the case in progress finishes and no further cases
are sent. **Resume test run** continues the same run without rerunning completed cases.
**Stop test run** aborts the requests in progress and keeps the completed results;
unfinished cases are never counted as passed. Keep the page open while paused; after a
reload or closing the page it is not a resumable pause. In **Test results** you can see
which cases finished and which did not, then choose **Run remaining cases (N)** to start the
next run yourself. The system never resends a request whose state was unknown when the
run was interrupted.

Controls that only the VS Code Extension Host provides, with no browser equivalent, are
simply disabled. Examples are linking a workspace suite, opening VS Code Test Explorer or
the Output channel, and every GitHub Copilot, Profile Doctor, and AI Advisory action.
These disabled controls are not a fault. Use the imported copies, tests, evidence, and
deterministic diagnostics inside Web, or run that action in the VSIX.

Before you run, make sure that:

- The target system allows this test traffic and the chosen Profile points at the right
  non-production environment.
- CSV and JSONC contain no production customer data, credentials, or prompts that must
  not leave your network.
- A timeout, a connection failure, or incomplete evidence does not mean the test passed.
- After exporting evidence or a report, you keep and share it according to your data
  classification policy.

## Browser data and backups

TurnStage Web data is isolated by site origin (scheme, host, and port):

- Profiles, Environments, display preferences, and sidebar folder organization are kept in
  versioned `localStorage`.
- Larger test suites, run records, evidence, campaigns, and visual baselines are kept in
  IndexedDB.
- The official Catalog is not written to the browser storage above.
- Credentials written directly into a Profile or Environment are stored in
  `localStorage`; `${secret.*}` session values exist only in page memory.
- Values of controls marked `workspace` or `global` are stored per Profile ID in this
  site origin's browser storage; `none` is not stored, and `secret` stays only in this
  page's memory and never appears in conversation snapshots. A control marked **reset on
  new conversation** returns to its default when a new conversation starts.

A different browser, a private window, another computer, domain, or port does not see
the original data automatically. Clearing site data also removes local data. Before you
change the URL or clear data, export the Profiles, Environments, test cases, and evidence
you want to keep.

## Frequently asked questions

### "Default profiles unavailable. Using bundled presets." is shown

The deployment Catalog could not be fetched, is malformed, exceeds the size limit,
contains duplicate IDs, or a Profile failed validation. Users can still use the built-in
templates; pass the status message to the deployer to check.

### The browser shows CORS or "Failed to fetch"

Check that the target API:

- is reachable from the user's computer;
- uses a TLS certificate the browser trusts;
- allows TurnStage Web's full origin;
- allows the HTTP methods and request headers it needs.

TurnStage Web cannot disable the browser's TLS verification or bypass CORS.

If the Environment named by the Profile does not exist, Web blocks the request and shows
a missing-environment error rather than using a different Environment. Import a portable
Profile that includes the Environment, or ask the deployer to add the official one. The
right-hand **Network** view shows the status codes of the opening and normal messages,
and a length-limited response preview with known credentials masked. If the Profile
configures reconnection, it retries only before the stream has received any data, within
its limits. On **Stop**, if the Profile configures a remote stop request, the browser
aborts locally and then tries to send it; a failure shows a warning.

### A session secret is gone after a reload

This is expected for `${secret.*}`. Enter it again and rerun the tests. If your
organization decides to share one fixed credential, write the plaintext value directly
into the Profile or Environment and share it through a portable file.

### I cannot find my earlier local Profile

Check that you are using the same browser, regular or private mode, protocol, domain, and
port, and that site data has not been cleared. If the deployment URL changed, you can only
re-import from a file you exported earlier.

### Do Web and the VSIX share data?

Not automatically. Web uses browser storage; the VSIX uses the VS Code workspace, the file
system, and SecretStorage. Between Web users, move Profiles and Environments with portable
Profile files. The VSIX can still import a legacy single Profile JSONC, but it does not
treat a Web portable file as an ordinary Profile.

## Before you finish

1. Make sure plaintext credentials in a Profile or Environment are shared only with people
   who may use them, and that cases and reports contain no production data.
2. Export the local data you need to keep or hand over.
3. Recheck an exported file before you share it.
4. On a shared computer, clear site data when you finish, following your organization's
   policy, after making sure you have the backups you need.
