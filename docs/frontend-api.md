# Chronicle frontend API contract

This contract lets frontend work proceed independently from the backend branch.
The frontend owns `src/web/public/`. Backend work must not edit those files.

All requests are scoped by `X-Chronicle-Workspace`. When the web server is bound
beyond loopback, send the configured bearer token in `Authorization` as well.

## Processing feed

`GET /api/processing?limit=50`

Returns newest-first recording and processing sessions for the selected workspace:

```json
{
  "workspaceId": "123",
  "totalCount": 1,
  "inProgressCount": 1,
  "attentionCount": 0,
  "sessions": [
    {
      "id": "uuid",
      "stage": "transcribing",
      "terminal": false,
      "attentionRequired": false,
      "createdAt": "2026-07-10T08:00:00.000Z",
      "updatedAt": "2026-07-10T08:01:00.000Z",
      "participantCount": 2,
      "optedOutCount": 0,
      "warningCount": 0,
      "warnings": [],
      "attempts": 1,
      "recoverable": true
    }
  ]
}
```

Stages are `connecting`, `recording`, `captured`, `queued`, `transcribing`,
`distilling`, `needs_review`, `completed`, `empty`, `failed`, and `discarded`.
Render the server-provided stage rather than estimating client-side progress.
The feed is newest-first and accepts a limit from 1 to 100. Completed records use
workspace-relative `recordPath` values; absolute host paths are never returned.

## Tasks

`GET /api/tasks?status=open|done|all&owner=Max`

The default status is `open`. The response is `{ tasks, workspaceId, status }`.
Each task contains `id`, `revision`, `status`, `owner`, `task`, timestamps, and a
chronological `sources` array. Every source includes record/transcript paths and
an Obsidian citation.

`GET /api/tasks/:id`

Returns `{ task, workspaceId }` and an `ETag` containing the current revision.

`PATCH /api/tasks/:id`

Send `If-Match` with the revision returned by the last read. The body can change
`owner`, `task`, or `status`:

```http
PATCH /api/tasks/00000000-0000-4000-8000-000000000001
If-Match: "3"
Content-Type: application/json

{"status":"done"}
```

The response is `{ task, saved: true }` with a new `ETag`. Missing revision
preconditions return `428`; stale revisions or duplicate-open-task transitions
return `409`.

Approving a review creates tasks only from approved action items. Exact normalized
owner/task matches append another source to the existing open task. For reviewed
semantic carryover with different wording, preserve or set `carryover_task_id` on
the draft action item. A matching action after the old task is completed creates
a new task instead of silently reopening history.

## Existing additive fields

- `GET /api/digest` now includes `openTasks` alongside the legacy `openActions`.
- Approval results can include `taskIds` for tasks materialized by that approval.
- Empty, unsupported report sections are valid. Frontend rendering must not assume
  that summary, decisions, action items, questions, or facts are populated.
- Review summaries can include `highlights`, an optional array of exact, durable
  source lines. Approved notes render them with transcript citations.
