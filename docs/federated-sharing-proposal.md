# Federated personal knowledge and project sharing

Status: discussion proposal

Decision owner: Ethan and Max

Implementation status: BLOCKED until Ethan and Max agree on the model

Last updated: 2026-07-10

## Why this document exists

Ethan and Max discussed separate personal knowledge bases, permission-based
cross-querying, automatic surfacing of useful overlaps, and different trust
levels for different people. The desired behavior is clear, but the storage,
identity, synchronization, and frontend rules were not decided.

This document bookmarks the recommended model. It is not authorization to build
multi-user sharing.

## Decision summary

Chronicle should expose spaces to users and keep databases behind those spaces.

- Ethan Personal connects to Ethan's Chronicle records, WOOZY WIKI, and narrow
  read-only views over woozy.db.
- Max Personal connects to Max's Chronicle and the sources he chooses.
- Chronicle Project is a separate shared space for Chronicle meetings,
  decisions, tasks, and deliberately published material.
- Pizuki Project and every other project get independent shared spaces.

Personal databases are never merged into one central database.

## Querying and publishing are different

Querying Max's personal knowledge is temporary and read-only. The question
travels to Max's Chronicle node, Max's policy is enforced there, and only the
minimum allowed evidence is returned. The result does not become Ethan's data
or project data.

Publishing to a project creates a reviewed shared snapshot with provenance. It
becomes durable project knowledge and stays available when the original
personal node is offline.

This distinction is mandatory:

- Share this answer: disclose one answer or excerpt for one request.
- Share this item: grant access to one source or record.
- Publish to project: create durable shared project knowledge.
- Update shared copy: deliberately replace a published snapshot after review.

No personal result is silently promoted into a project.

## How a cross-person query should work

1. Chronicle identifies the requester and active project.
2. The requester chooses This project, My memory, or Team permitted.
3. The shared project index is searched.
4. The requester's personal providers are searched locally.
5. Signed requests go to any permitted teammate nodes.
6. Each owner node applies authorization before retrieval.
7. Nodes return small approved excerpts with stable citations.
8. The coordinator deduplicates and reranks evidence.
9. The answer is generated only from authorized evidence.
10. The answer reports unavailable sources, conflicts, owner, space, source
    type, freshness, and access mode.

The final model must never receive excluded content and then be asked to redact
it. Access filtering happens before retrieval and before model input.

## Max's connection to Chronicle

Max does not upload his whole database.

Max runs a Chronicle node beside his data and grants it read-only access to
specific sources. The node maintains local indexes and exposes narrow
operations such as:

- search approved knowledge
- list selected project tasks
- get one authorized evidence excerpt
- report connector availability

For SQLite, Chronicle uses predefined typed queries or safe views. It never
accepts model-generated SQL. For Markdown, folder defaults and page-level
visibility metadata determine eligibility.

Effective access is the intersection of:

1. Source permission: Chronicle may read the folder, table, or provider.
2. Record permission: the page or row is approved and share-eligible.
3. Recipient permission: the requester or project may access it.
4. Capability permission: the exact requested operation is granted.

## Knowledge state and access capabilities are independent

Accuracy state:

    raw -> draft -> approved

Private is the absence of grants. Other access modes are independent
capabilities, not a ladder:

- discover activity or existence
- query approved evidence
- read the item directly
- publish a reviewed snapshot to a project

Approval means a record is accurate enough for the owner's memory. It does not
mean another person may see it. Query permission does not imply direct read,
direct read does not imply publication, and publication does not expose the
owner's personal copy or future revisions.

Raw captures, drafts, credentials, financial data, health data, private
journals, and third-party confidential material remain excluded by default.

## Trust presets

The first release should use understandable presets:

- Project only: shared project spaces are visible; personal data is never
  searched.
- Ask me: the owner approves the exact proposed excerpt for each request.
- Trusted collaborator: approved, explicitly eligible material can answer
  automatically.
- Blocked: no query or request.

Avoid a vague numeric trust score and avoid Full access in the first release.
Every grant needs a person, data scope, capability, exclusions, and optional
expiry.

In Ask me mode, the requester sees Request sent. They must not learn whether a
private match exists, how many results exist, or what their titles are before
approval.

## Canonical ownership

- Ethan durable knowledge: WOOZY WIKI.
- Ethan tasks and deadlines: woozy.db.
- Max durable knowledge and operations: Max's chosen systems.
- Shared project knowledge: the project's Chronicle Markdown workspace.
- Shared project tasks: the project's declared task provider.
- Chronicle search indexes: derived and rebuildable.
- Generated query answers: derived and non-canonical.

Chronicle may present one unified view, but every item keeps one canonical
provider. Other systems store references rather than editable duplicate copies.

## Security prerequisites for Phase 6

The frontend must not label data Private or expose cross-node controls until
the underlying guarantees exist. Multi-user work requires:

- stable user, node, and device identities, including an explicit mapping from
  Discord accounts to Chronicle accounts
- node pairing, key exchange, rotation, recovery, and revocation
- authenticated encrypted transport plus signed requests with nonces,
  timestamps, and replay protection
- owner-side grant evaluation before retrieval, with deny-by-default source,
  recipient, capability, and expiry checks
- globally stable Source and revision IDs that support citations without
  leaking undiscoverable records through deduplication
- a declared authority for project membership, project writes, concurrent
  updates, and conflict resolution
- signed or otherwise tamper-evident audit receipts for queries, disclosures,
  publication, denial, and revocation
- explicit cache, retention, metadata-leakage, and compromised-node behavior in
  the threat model

Secure discovery is also part of this phase. Chronicle must not assume that a
hostname, caller-provided workspace header, shared bearer token, or claimed
owner field proves identity.

## Frontend model

Users select spaces, not databases.

- Persistent space switcher: Personal, Chronicle, Pizuki, and other projects.
- Search scopes: This space, My memory, Team permitted.
- Evidence labels: Shared project, Ethan - WOOZY, Max - shared with you.
- Personal evidence action: Publish to project.
- Project home: shared memory, decisions, tasks, processing, members, and
  activity.
- Settings: Connections, People and access, Requests, and Audit log.

If a teammate node is offline, Chronicle answers from available evidence and
marks that source unavailable. It must not silently use a stale private replica.
Important knowledge should be published to the project when offline
availability matters.

## Audit and revocation

The owner's audit should record:

- who asked
- exact question
- policy applied
- exact evidence disclosed
- source IDs and revisions
- manual or automatic approval
- any cloud processor used
- publishing, denial, and revocation events

Revocation stops future queries and invalidates Chronicle-managed caches and
grants. Chronicle cannot make a recipient forget or delete an external copy;
the interface must say that plainly.

## Decisions Ethan and Max must make

- Which personal sources can Chronicle connect to?
- Should Ethan and Max's default relationship be Project only, Ask me, or
  Trusted collaborator?
- Which collections are permanently excluded?
- Do projects always get a shared wiki?
- Can teammates see that a private item exists without seeing its content?
- What may be cached when an owner is offline?
- What is the retention and retraction policy for project-published snapshots?
- Which system owns shared project tasks?
- Which queries may use cloud models?
- What should the query and sharing audit expose to each side?

No identity, grants, cross-person querying, private activity sharing, or
project publishing should ship before these decisions are made.
