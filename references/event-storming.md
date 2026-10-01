# Current Event Storming Model

## Purpose

This file records the current bounded contexts, actors, commands, events, and
rejections from the Event Storming board. Architecture details belong in
`references/architecture.md`.

## Bounded-contexts

- Identity
- Resources

## Identity

User registration and authentication. No aggregates or transitions are drawn on
the board.

## Board transcription

### Resources

| Owner                      | Trigger (actor/event)              | Command                     | Event(s)                        | Rejections                           |
| -------------------------- | ---------------------------------- | --------------------------- | ------------------------------- | ------------------------------------ |
| Organization               | Platform Operator                  | Create Organization         | Organization Created            | Organization Already Exists          |
| Organization               | Platform Operator                  | Add Organization Member     | Organization Member Added       | Organization Member Already Added    |
| Resource Registration (PM) | Platform Operator                  | Register Resource           | Resource Registration Requested | —                                    |
| Resource Registration (PM) | on Resource Registration Requested | Create Resource             | —                               | —                                    |
| Resource                   | Resource Registration (PM)         | Create Resource             | Resource Created                | Resource Already Exists              |
| Resource Registration (PM) | on Resource Already Exists         | —                           | Resource Registration Failed    | —                                    |
| Resource Registration (PM) | on Resource Created                | Add Resource                | —                               | —                                    |
| Organization               | Resource Registration (PM)         | Add Resource                | Resource Added                  | Resource Name Already Used           |
| Resource Registration (PM) | on Resource Name Already Used      | Delete Resource             | —                               | —                                    |
| Resource                   | Resource Registration (PM)         | Delete Resource             | Resource Deleted                | —                                    |
| Resource Registration (PM) | on Resource Added                  | —                           | Resource Registered             | —                                    |
| Resource Registration (PM) | on Resource Deleted                | —                           | Resource Registration Failed    | —                                    |
| Resource                   | Resource Manager                   | Open Resource For Requests  | Resource Opened For Requests    | Resource Already Open For Requests   |
| Resource                   | Resource Manager                   | Close Resource For Requests | Resource Closed For Requests    | Resource Already Closed For Requests |

Process: **Resource Registration** runs `Register Resource → Resource
Registration Requested → Create Resource → Resource Created → Add Resource →
Resource Added → Resource Registered`, then completes on `Resource Registered`.
If `Add Resource` rejects `Resource Name Already Used`, it runs `Delete Resource
→ Resource Deleted → Resource Registration Failed`, then completes.

Projections: **Organization View** receives Organization Created, Organization
Member Added, and Resource Added. **Resource Catalog Item** receives Resource
Created, Resource Deleted, Resource Opened For Requests, and Resource Closed For
Requests. The request-and-approval process reads the resource catalog directly
for policy; there is no separate request-policy mirror projection.

#### Request & approval

| Owner               | Trigger (actor/event) | Command                         | Event(s)                           | Rejections                                                                                                                          |
| ------------------- | --------------------- | ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Access Request (PM) | Requester             | Submit Access Request           | Access Request Submitted           | Resource Not Open For Requests; Access Level Not Offered; Requested Duration Too Long; Request Already Pending; Access Already Held |
| Access Request (PM) | Requester             | Submit Access Extension Request | Access Extension Request Submitted | Resource Not Open For Requests; Access Grant Not Active; Requested Duration Too Long; Request Already Pending; Access Already Held  |
| Access Request (PM) | Manager               | Approve Access Request          | Access Request Approved            | Request Already Decided; Not An Eligible Manager; Access Already Held; Access Grant Not Active                                      |
| Access Request (PM) | Manager               | Deny Access Request             | Access Request Denied              | Request Already Decided; Not An Eligible Manager                                                                                    |
| Access Request (PM) | Requester             | Cancel Access Request           | Access Request Canceled            | Request Already Decided                                                                                                             |

Submission captures managers in policy order and removes duplicates. A
requester who is also a manager may decide the request.

Projection inputs and outputs drawn on the board:

- **Access Request View** receives Access Request Submitted, Access Extension
  Request Submitted, Access Request Approved, Access Request Denied, and Access
  Request Canceled — the requester's read model of each request and its status.
- **Access Decision Assignment** receives Access Request Submitted, Access
  Extension Request Submitted, Access Request Approved, Access Request Denied,
  and Access Request Canceled; it also receives Access Grant Revoked, dropping
  pending extensions of that grant.

#### Access grant — Access Grant PM

| Owner             | Trigger (actor/event)      | Command                                      | Event(s)              | Rejections                                    |
| ----------------- | -------------------------- | -------------------------------------------- | --------------------- | --------------------------------------------- |
| Access Grant (PM) | on Access Request Approved | Create Access Grant `OR` Extend Access Grant | —                     | —                                             |
| Access Grant (PM) | Access Grant (PM)          | Create Access Grant                          | Access Grant Created  | —                                             |
| Access Grant (PM) | Access Grant (PM)          | Extend Access Grant                          | Access Grant Extended | Access Grant Not Active                       |
| Access Grant (PM) | Resource Manager           | Revoke Access Grant                          | Access Grant Revoked  | Access Grant Not Active; Not Resource Manager |

The grant holds the request that issued it, the extension requests that moved
its end, a start, an end, and whether it was revoked. Nothing happens
when its period begins or ends. Whenever a request depends on the grant, the
system checks against the current time whether the grant gives access, that
is, whether it is not revoked and the current time is within its period.

Projections: **Access Grant View** and **Grant Coverage** receive Access Grant
Created, Access Grant Extended, and Access Grant Revoked.

#### Audit

Projections over durable facts, retained in history and redacted. Details in
`references/architecture.md`.
