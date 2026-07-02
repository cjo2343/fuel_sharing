---
name: govehlo-design
description: Use this skill to generate well-branded interfaces and assets for GoVehlo — a fuel ledger and car-sharing companion for friend groups in Denmark. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping or production work.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## State Patterns — Required in All Prototypes

GoVehlo is PWA-first. Every prototype and screen MUST include appropriate state handling — not just the happy path. Use these components:

- **Loading:** Use `Skeleton` (shimmer placeholder, Mist-green) for content loading and `Spinner` (circular indicator + label) for discrete actions. Replace button labels with `<Spinner size="sm" color="white" />` during submission.
- **Error:** Use `ErrorBanner` for persistent errors (`variant="error"` for failures, `variant="warning"` for data conflicts, `variant="offline"` for connectivity loss). Use the `Input` `error` prop for field validation. Voice: explain the problem and guide the fix — "Must be higher than start (45 318 km)" not "Invalid value."
- **Empty:** Use `EmptyState` for zero-data sections. Encouraging copy — "No trips yet" not "No data available." Include a CTA when possible.
- **Offline:** Use `ErrorBanner variant="offline"` with message "Connection lost. Your changes are saved locally." and an `onRetry` handler.
- **Toast:** Use `Toast` for transient action feedback (auto-dismiss). `variant="error"` for failed discrete actions. Payment actions always show a toast per brand spec.

See the readme State Patterns section for the full decision tree (Toast vs ErrorBanner vs EmptyState vs Skeleton vs Spinner).

Read the `.prompt.md` files in `components/feedback/` for usage examples and voice guidelines.

## Workspace Switcher — Admin Pattern

The admin sidebar includes a `WorkspaceSwitcher` component for switching between car-sharing groups. It is integrated into `templates/admin-shared/AdminLayout.js` and renders automatically in all admin templates.

- **Prototype:** `ui_kits/admin/workspace-switcher.html` — standalone interactive demo
- **Guideline card:** `guidelines/patterns-workspace-switcher.card.html` — Default / Hover / Open states
- **Design:** Dark dropdown (`#243A2A`) in the sidebar, 28px rounded-square avatars with group initials, animated entrance (160ms), leaf-green checkmark on active workspace, "Create new group" action at bottom.
- **Data shape:** `{ id, name, members, color, initial, role }` — currently hardcoded with 3 sample workspaces. Wire `activeId`/`onSwitch` props in production.
- **Exported as:** `window.WorkspaceSwitcher` from AdminLayout.js.
