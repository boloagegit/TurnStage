# Enterprise chat profile guide

This guide uses the bundled synthetic `/v1/chat/*` server to model an
enterprise POST + SSE contract. The profile is an adapter example: TurnStage's
runtime remains vendor-neutral, while request fields and raw event names stay
inside `enterprise-chat.turnstage.jsonc`.

## Run the bundled contract

1. In the TurnStage repository, run `npm run mock-server`.
2. In the target VS Code workspace, run **TurnStage: Initialize Workspace**.
3. Choose **Enterprise Chat Contract** and the local mock environment.
4. In the TurnStage Profiles view, select **Run Profile** on Enterprise Chat
   Contract.
5. Keep the environment on `local`, select a synthetic actor and mock scenario,
   then send a message.

The mock server listens on `http://127.0.0.1:8787` by default. The local
environment supplies this as `${env.baseUrl}`; it contains no credential.

## Request model

The opening request is configured under `opening.request` and posts the actor,
task, block, tags, and opening-message arguments to `/v1/chat/opening`. A `7021`
response selects the configured fallback greeting. `optionsInfo`, when present,
becomes starter prompts through `opening.response.startersPath`.

The first send variant is selected while `conversation.id` does not exist. It
sends the trimmed input, displayed opening message, and synthetic conversation
profile. The continuation variant is selected after a `conversation.started`
event establishes the conversation ID; it sends the input and `cid`.

The stop configuration first aborts the local stream, then posts the current
conversation ID and live Assistant message ID to `/v1/chat/stop`. If either ID
has not arrived, TurnStage performs a local abort and records a warning instead
of inventing remote identifiers.

## Event mapping and debugging

The example maps `start`, `status`, `message`, `followup`, two CTA shapes,
`diagnostic`, `title`, `done`, and `error` into TurnStage's canonical events.
Vendor payload fields such as `messageText` and `ctaKey` are converted by the
profile into generic action payload fields named `text` and `interactionKey`.

`custom_card` is deliberately not mapped. It remains in **Debug → Raw Events**
with an Unmatched status, can be searched by `custom_card`, and can be inspected
or used to create a mapping draft. This proves that proprietary event shapes do
not break the stream without making them part of the generic TurnStage UI.

Useful Raw Events filters are:

- **Event type** for an exact SSE event name.
- **Mapping status → Unmatched** for events the profile does not understand.
- **Event health** for parsing and mapping failures.
- **Terminal status** for events that produced a canonical completed, failed,
  or aborted result.
- **Search events** for text, IDs, or payload values in the bounded event JSON.

Raw and Normalized filters are stored separately in VS Code Webview state, so
switching tabs or restoring the editor keeps the inspection context.

## Mock scenarios

The `mode` control selects deterministic server behavior:

- `normal`: `start → status → message → title → done`.
- `contract-slow`: delayed SSE chunks for visible streaming and stop tests.
- `contract-error`: a terminal synthetic service error after partial content.
- `contract-actions`: follow-up, request CTA, web-link CTA, unmatched
  `custom_card`, diagnostic, title, and completion events.
- `opening-options`: a configured opening message with starter options.

## Adapt it to a real environment

Copy the synthetic profile and change only the adapter boundaries:

1. Point an environment variable such as `baseUrl` to the real service.
2. Put tokens in VS Code SecretStorage with **TurnStage: Set Secret**, and refer
   to them through the environment's `secretReferences`; never put secret values
   in the profile.
3. Replace synthetic request constants and control options with non-sensitive
   test values appropriate for the environment.
4. Keep first-turn and continuation variants separate when their bodies differ.
5. Map only event shapes the test needs to render. Leave proprietary or unknown
   events unmatched when inspection is sufficient.
6. Restrict `security.allowedDomains`, URI schemes, and commands to the minimum
   required set.
7. Validate first against a non-production endpoint and inspect the redacted
   Request preview before sending.

Do not treat client-provided `conversationProfile` values as authentication.
Identity and authorization must be established and verified by the backend.
