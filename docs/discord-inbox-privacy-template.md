# Chronicle Discord Inbox privacy notice template

Status: operator template; not a published policy

Replace every bracketed field, review it with the server owners, publish it at a
public HTTPS URL, and set that URL as `DISCORD_PRIVACY_POLICY_URL` before
enabling Inbox mode.

## What Chronicle collects

Chronicle collects new messages intentionally posted in the Discord channels
listed as Chronicle Inbox channels. A capture can include message text, the
Discord message/guild/channel identifiers, author account identifiers and
display names, timestamps, submitted links, and attachment metadata. Chronicle
does not fetch historical channel messages or scan channels that are not
explicitly configured as inboxes.

## Why Chronicle processes it

Chronicle saves submitted material into a local Library and may summarize plain
text or ordinary web pages. YouTube and social-media links remain link-only
bookmarks until Chronicle has an encrypted media-artifact pipeline. Discord
message content is not used to train or fine-tune machine-learning models.

## Storage and processors

Inbox sources and derived analysis are encrypted at rest on [operator/system]
using AES-256-GCM. They are not written to Chronicle's plaintext Markdown or
search index. Processing uses [local model details]. If a remote processor is
enabled, list its operator, purpose, region, and applicable policy here before
using it with Discord data.

## Retention and deletion

Content is retained for [number] days, then erased to a content-free encrypted
tombstone. A Discord deletion observed while the bot is online also erases the
stored content. Chronicle does not read channel history, so it cannot guarantee
that it observes deletions made while the bot is offline.

## Access, export, correction, and deletion requests

Users can request a copy of their stored data, correct it, or ask for deletion
at [public data-request URL]. Requests are handled by [operator/contact] within
[response period]. Users can report application or policy problems through the
same route or at [support route].

## Sharing

Inbox data is local-only in the current release. It is not shared with another
Chronicle user or project unless a future, separately documented permission
system is implemented and the user explicitly grants access.

Last updated: [absolute date]
