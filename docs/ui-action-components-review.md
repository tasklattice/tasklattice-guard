# UI Action Component Review and Conventions

Date: 2026-09-12. This follows the user-confirmed blue for creation, yellow for editing, and red for deletion, replacing the earlier green-creation convention.

## Review Conclusions

The system already has shared Button, DropdownMenu, EntitySheet, and ConfirmationSheet components with strong reuse of base forms. The gap is a consistent convention for action semantics, emphasis, and risk. Adding thin wrappers such as CreateButton, EditButton, and DeleteButton would not automatically solve it.

### Confirmed Issues and Fixes in This Round

| Location | Issue | Fix |
| --- | --- | --- |
| ui/button.tsx | create used green, while default creation actions used brand blue | create and default share one primary style definition using theme variables |
| Router and Guardrail creation actions | Relied on the default variant, so code did not express creation intent | Explicitly use create |
| Router, Guardrail, and Policy detail editing | Mixed outline/default | Explicitly use edit, with a light-yellow background and dark text |
| ui/dropdown-menu.tsx | Supported only normal and destructive semantics, with no edit equivalent | Added edit; Route menus use it explicitly while ellipsis triggers remain neutral |
| Guardrail and Policy deletion actions | Pages assembled deletion colors through className, potentially leaving a neutral default state | Use destructive and remove page-level color overrides |
| confirmation-sheet.tsx | warning changed only the icon; the confirmation button remained blue | warning confirmation uses yellow; destructive remains red |

## Action Colors and Emphasis

| Action | Component expression | Appearance |
| --- | --- | --- |
| Creation confirmation for Create, Add, Duplicate | Button variant=create | Brand blue |
| Edit, Apply changes | Button variant=edit | Light-yellow background, dark-yellow text |
| Execution or confirmation of Delete, Revoke | Button variant=destructive | Red |
| Primary workflow actions such as Review, Publish, and running tests | Default Button variant | Brand blue; blue is not exclusive to creation |
| Cancel, Close, Back, Copy, view details | outline / ghost / link as appropriate | Neutral or link style |
| Row-end action entry | ghost icon button + DropdownMenu | Neutral ellipsis; menu items express action semantics |

Color is neither risk level nor a confirmation workflow. Blue creation actions should not automatically require confirmation. Editing a draft and publishing live configuration have different impacts, as do removing a local form row and deleting a persisted object. Green success and yellow warning status badges are not action buttons and should not be replaced in bulk.

## Abstraction Boundaries

1. **Theme and visual primitives**: Button / DropdownMenuItem own colors, hover, focus, and disabled states; retain existing primary/destructive theme variables. Future theme expansion should centralize amber edit colors in theme tokens instead of repeating colors on each page.
2. **Composed interactions**: EntitySheet owns the side-panel frame; ConfirmationSheet owns cancel/confirm, pending state, and close protection. This layer does not decide whether an object can be deleted or whether live traffic is affected.
3. **Business actions**: GuardrailRowActions and Router action handlers own permissions, impact queries, API calls, and cache refreshes. The business layer selects semantic variants without hand-writing button colors.

A generic CRUD component covering all objects is not recommended now. Guardrail deletion requires dependency queries, Route deletion changes only a draft, and Endpoint credential revocation may take effect immediately. Forcing them into one component would introduce many switches.

## Remaining Standardization Scope

This round corrects global shared definitions and migrates core paths; it does not mean every page has explicit semantic annotations. Remaining submission actions in creation wizards, the Policy editor, Models, Settings, and elsewhere need classification individually. Do not replace them automatically based on button labels or Plus/Pencil icons.

Height consistency should be handled separately. size=default is currently 36px, while many console actions add min-h-11. Establish a clear console-density size convention before migrating, rather than globally enlarging all buttons and disrupting compact tables and editors in this round.

Route currently implements deletion confirmation directly with EntitySheet; Guardrail uses a business-specific deletion sheet, while other pages reuse ConfirmationSheet. Simple confirmations can move to ConfirmationSheet first while retaining slots for business-impact content. This round does not change deletion behavior.

## Acceptance Conventions

New pages must explicitly select creation, edit, and deletion semantics. className is for layout, not action-color overrides. Row ends retain only the ellipsis menu rather than permanent sets of colored icons. Read-only users receive no write actions; pending state blocks duplicate submissions; confirmation for sensitive actions must name the object and actual impact.

## Follow-up Fix Record

Further migrations cover Router creation confirmation, adding/removing Routes, Selector conditions/groups/values, GuardRail target removal, GuardRail duplication, draft editing, Endpoint registration/deletion/credential revocation, Models addition/removal, test-case addition/deletion, and protection-binding removal. All use existing shared variants without changing action permissions or confirmation behavior. Twelve relevant regression tests and frontend/backend builds passed. The 38184 preview was restored, but the backend rejected login from that preview origin (Invalid origin), so authenticated visual revalidation was not completed in this round.

## Router Detail and List Actions

The detail-page header uses an explicit, equal-height, wrapping button group: Edit routing and Rename Router use yellow `edit`; View revisions uses neutral `outline`. Viewing actions do not use the creation color. Creation stays blue `create`, and deletion stays red `destructive`.

List rows use an ellipsis menu for view details, edit routing, and view revisions; editing is visible only to administrators. Direct buttons on detail pages and menus in lists serve different information densities while reusing the same semantic colors. Detail-page actions are no longer hidden inside an ellipsis menu.
