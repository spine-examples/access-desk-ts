# How to Contribute

Thank you for wanting to contribute to Access Desk — a demo-sized,
production-shaped [Spine TS](https://github.com/SpineEventEngine/spine-ts)
application for organization-scoped resource access requests, approvals,
scheduling, and audit. The following resources will help you get started:

* [What the project is and how to build and run it](README.md).
* [Product background](PRD.md).
* [The canonical architecture and domain invariants](references/architecture.md).

If you are new to the framework, the
[Spine documentation](https://spine.io/docs/introduction) explains the
event-sourcing and bounded-context foundations that Access Desk is built on.

## Pull Requests

The contribution process begins with creating an issue that describes a bug or
feature request. This issue serves as a communication channel for discussing
proposed improvements. When code changes are involved, the issue should include
a link to the corresponding Pull Request.

Keep each Pull Request focused on a single behavior slice, and describe the
behavior it changes, the affected bounded contexts, and the verification you
ran.

Code contributions must:

* Include accompanying tests.
* Be licensed under the Apache v2.0 license with the appropriate copyright
  header on each file.
* Follow the established code style — match the surrounding TypeScript in
  naming, structure, and comment density, and respect bounded-context import
  boundaries.

## Contributor License Agreement

All code contributions to the Spine Event Engine ecosystem require a Contributor
License Agreement (CLA).

* Individual contributors: If you are writing original source code and own
  the intellectual property, you'll need to sign an individual CLA.

* Corporate contributors: If you work for a company that wants to contribute
  your work, an authorized person from your company will need to sign a
  corporate CLA.

Please [contact the team](mailto:legal@teamdev.com) to arrange the necessary
formalities.
