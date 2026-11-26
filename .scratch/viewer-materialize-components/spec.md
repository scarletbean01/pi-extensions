# Factory web viewer: Materialize components instead of custom styles

Status: done. Merged to main 2026-11-25 (merge f300943, branch feature/viewer-materialize, slices 1-3, each reviewed by an Opus reviewer). Verified: viewer tests 77/77 and docs tests 6/6 (83/83 on main); guard test with empty legacy allowlists and negative controls; wording diffed against the pre-branch viewer; a headless Chrome pass (7 views at 1280px and 390px, no horizontal scroll, no external requests, no CSP errors, Scenario 1 and 5, reduced motion, drawer). NOT YET RUN: a browser re-check after the final fix commit (37d0800), Scenario 3 re-run after the migration, full human keyboard-only traversal, screen-reader and real-device checks, and the read-only byte-for-byte fixture check; these are listed as NOT YET RUN in the viewer guide. Known deliberate change: the Factories drawer button's visible text is hidden at 600px and below (accessible name kept). Prepared 2026-11-25 from a grill-with-docs session (15 decisions, all accepted as recommended). The test seam is the existing one: the viewer's served assets over HTTP, including the DOM harness that runs the served client scripts (accepted as part of decisions 14 and 15). Vocabulary follows `GLOSSARY.md` (software factory, **Deleted factory**, **Run graph**). Architecture follows ADR 0001: the viewer observes and never drives. No glossary term or ADR comes out of this work; the choices are easy to reverse and the vendor README records the one a reader might question (Materialize CSS without its JavaScript).

## Problem Statement

The viewer loads Materialize 1.0.0 but barely uses it. Most of what an operator sees comes from a parallel set of hand-written components (about 111 rules in 855 lines) with their own colours, buttons, tables, accordions, chips and cards. So:

- The viewer does not look like Materialize, although that is the chosen UI stack.
- Every visual change means maintaining a private component library beside a vendored one.
- Nothing stops new custom components from being added.

## Solution

Build the viewer from Materialize 1.0.0 markup and CSS classes, as documented at materializecss.com. The local stylesheet shrinks to a short list of things Materialize cannot provide, and an automated guard keeps it there.

What the viewer shows and how it behaves stay the same, except for three deliberate changes:

- View tabs become links.
- The header is no longer sticky.
- Spacing, shapes and colours follow Materialize.

Where the Materialize look and less CSS conflict, the Materialize look wins. Where either conflicts with accessibility, accessibility wins.

## User Stories

Look and shell

1. As an operator, I want the viewer to look like a Materialize application, so that it is consistent with the chosen UI stack.
2. As an operator, I want one header containing the viewer name, the selected factory and the view tabs, so that I can see where I am.
3. As an operator, I want the current view marked by text emphasis and an underline indicator, so that colour is not the only cue.
4. As an operator, I want the view tabs to be real links, so that I can open a view in a new browser tab.
5. As an operator, I want tabs that need a factory to look and act unavailable until I select one, so that I do not land on an empty view.
6. As an operator on a narrow screen, I want the tabs to scroll sideways, so that all seven stay reachable.
7. As an operator on a wide screen, I want the factory list always visible beside the content, so that I can switch quickly.
8. As an operator on a narrow screen, I want the factory list in a drawer with a dimmed overlay, so that content gets the full width.
9. As an operator, I want the selected factory highlighted in the list, so that I know which one I am viewing.
10. As an operator, I want each factory's name and details to fit in its list entry, so that nothing is clipped.
11. As an operator, I want Deleted and Damaged factories kept in their own sections, so that they are not mixed with active ones.
12. As an operator, I want the Deleted section collapsed by default and to stay as I left it, so that refreshes do not disturb me.

Content

13. As an operator, I want every status shown as a chip with its symbol and text, so that I can read it without relying on colour.
14. As an operator, I want banners for blocked, uncertain, stale, deleted and error states as coloured card panels, so that important states stand out.
15. As an operator, I want warnings readable on their tint, so that I do not miss them.
16. As an operator, I want facts in a responsive grid, so that they use wide screens and stack on narrow ones.
17. As an operator, I want nodes and records in cards, so that each one is clearly separated.
18. As an operator, I want tables striped and highlighted on hover, so that rows are easy to follow.
19. As an operator on a narrow screen, I want wide tables to scroll sideways inside their own area, so that the page does not and long reasons still wrap.
20. As an operator, I want expandable details with a visible open/closed marker, so that I know what can be opened.
21. As an operator, I want the Queue filter buttons to show which one is active, visually and to assistive technology, so that I know what I am seeing.
22. As an operator, I want the receipt lookup and version selector in Materialize form styling with visible labels, so that I know what to enter.
23. As an operator, I want related links and secondary factory lists as collections, so that lists look the same everywhere.
24. As an operator, I want long identifiers to wrap, so that they do not break the layout.
25. As an operator, I want content links underlined, so that I can tell them from text without colour.
26. As an operator, I want headings sized for a dashboard, so that content is not pushed off screen by v1's very large defaults.

Live Graph

27. As an operator, I want the Run graph drawn as before, in Materialize palette colours, so that it matches the rest.
28. As an operator, I want pan, zoom and the selected node to survive polling, so that refreshes do not interrupt me.
29. As an operator, I want opened details and keyboard focus to survive polling, so that I can read while the run proceeds.
30. As an operator, I want Stale, Uncertain and Ended to remain distinguishable in words, so that I am not misled.

Accessibility

31. As a keyboard user, I want a visible focus outline on every interactive element, including those where Materialize removes it, so that I can see where I am.
32. As a keyboard user, I want the drawer to move focus in, trap it, close on Escape and return focus, so that it works as it does today.
33. As a keyboard user, I want the closed drawer out of the tab order on narrow screens, so that focus never goes off screen.
34. As a screen-reader user, I want the same landmarks, heading levels, current-page and pressed states as today, so that navigation still works.
35. As a screen-reader user, I want unavailable tabs announced as disabled, so that I understand why they do nothing.
36. As a screen-reader user, I want tables to keep their table semantics at every width, so that headers stay associated with cells.
37. As a low-vision user, I want text to meet 4.5:1 contrast (3:1 for large text and UI parts), so that I can read it. Disabled tabs are exempt.
38. As a motion-sensitive user, I want reduced motion respected for Materialize transitions too, so that nothing animates against my setting.

Safety and maintenance

39. As an operator, I want the page to make no external requests, so that it stays local.
40. As an operator, I want the content security policy unchanged, so that the read-only page stays as locked down as now.
41. As a maintainer, I want no Materialize JavaScript, so that no `innerHTML` sinks or competing widget behaviour enter the page.
42. As a maintainer, I want a test that fails on an unknown class or a new local selector, so that custom components cannot quietly return.
43. As a maintainer, I want one place that maps status tone to palette classes, so that colour changes are one edit.
44. As a maintainer, I want the vendor README to say why only the CSS is used, so that nobody adds the JavaScript by accident.
45. As a maintainer, I want the viewer guide to describe the new shell and checks, so that the docs stay true.

## Implementation Decisions

- **Version.** Stay on the vendored `materialize-css` 1.0.0 stylesheet. Do not change its rules. The maintained 2.x fork is out of scope.
- **CSS only.** No Materialize JavaScript, Material Icons or webfonts. Icons stay inline SVG. Materialize's own system font stack replaces the local font override. The asset allowlist, CSP and JavaScript route refusal do not change.
- **Modules touched.** The page shell, the client application script, the local stylesheet, the asset tests and the docs. The server and snapshot code do not change. The pure client-logic script keeps its `tone-*` values as semantic keys.
- **Colours.** The `--fv-*` tokens go away. Measured contrast:
  - Header: `blue-grey darken-3`, white text (9.65). Inactive transparent tabs on it: 5.71.
  - Buttons and active items: `teal darken-3`, white text (6.61).
  - Content links: `blue-text text-darken-3` (5.75 on white), underlined.
  - v1 defaults that must not survive in visible text: pink navbar (2.95), default teal (3.0), default link (3.08).
- **Tone map.** One map in the client application turns each tone into palette classes for chips and banners:
  - ok: green on `green lighten-5` (7.0 with `darken-4` text)
  - warn: `brown-text text-darken-3` on `amber lighten-5` (10.66). Orange text is not used (3.46).
  - error: red on `red lighten-5` (5.75 with `darken-4` text)
  - info: blue on `blue lighten-5` (7.56 with `darken-4` text)
  - muted: `grey-text text-darken-3` on `grey lighten-3` (8.66)
  - stale: a blue-grey tint, kept distinct from warn and from muted
- **Header and tabs.** One `nav.nav-extended` in the header, with the brand and scope above `ul.tabs.tabs-transparent`. Each tab is an `li.tab` with a link.
  - Hrefs are kept current for the selected factory, filter and receipt reference, and are set through the existing safe-href attribute helper. Direct href writes are rejected by the sink scan.
  - Plain clicks navigate in page; modified and middle clicks fall through to the browser.
  - The current tab has `.active` and `aria-current="page"`.
  - Unavailable tabs have no `href`, carry `aria-disabled="true"` and a muted text class.
  - The client positions Materialize's `.indicator` by assigning style properties, which the CSP allows. Style attributes and inline styles stay forbidden. The indicator is recomputed on view change and resize.
  - The header is not sticky: v1's `navbar-fixed` has a fixed height that does not fit the tabs.
- **Sidebar.** `aside.sidenav.sidenav-fixed` contains a `div` with navigation role and the Factories label, which avoids v1's global `nav` bar styling. Factories are `a.collection-item` in a `div.collection`, with `.active` plus `aria-current` on the selected one. Sidenav's own 48px links are not used. The existing IDs are kept.
- **Drawer.** The existing drawer script keeps its focus, Escape, focus-trap and inert handling. The backdrop uses `sidenav-overlay`. When closed on narrow screens, the drawer is not focusable. The page content uses Materialize's documented 300px offset on wide screens.
- **Component mapping.**

  | Today | Materialize |
  |---|---|
  | status pill | `chip` + tone classes |
  | status banner | `card-panel` + tone classes |
  | panel cards, node cards | `card` / `card-content` / `card-title` |
  | facts grid | `dl.row` with `div.col s12 m6 l4` |
  | primary / secondary buttons | `btn` / `btn-flat`; a pressed filter is `btn`, keeping `aria-pressed` |
  | link lists, Deleted and Damaged lists | `collection` |
  | inline form | `input-field` with a static `active` label; `select.browser-default` |
  | tables | `striped highlight` inside a scroll wrapper, never `responsive-table` |
  | accordions | native `<details>` with `collapsible`, `collapsible-header`, `collapsible-body` |

- **Custom CSS that may remain.** Nothing else, and no rule may restyle a Materialize component for taste:
  1. Run graph SVG, using Materialize palette hex values
  2. Focus outlines
  3. Skip link and screen-reader-only text
  4. Reduced motion
  5. Drawer open/closed state, overlay visibility, 300px content offset
  6. Accordion body shown when open, and the native open/closed marker kept
  7. Table scroll wrapper
  8. Heading sizes: h1–h4 use v1's own h5/h6 sizes and margins; levels are unchanged
  9. Wrapping for long identifiers
  10. Contrast fixes and content-link underlines
- **In-place patching.** Live Graph keeps its patching approach. Markup changes must keep the element identity that pan/zoom, selection, open details and focus rely on.
- **Slices.** One branch, three slices: (1) shell and guard test, (2) shared components and views, (3) graph colours, cleanup and docs. The guard starts with a temporary legacy allowlist that slices 2 and 3 shrink to empty.

## Testing Decisions

- **What a good test is.** Assert on what the viewer serves and on the DOM the served scripts produce, not on helper structure.
- **Seam.** The existing one: served assets over HTTP, plus the existing harness that runs the served scripts against a fake DOM. No new seam.
- **Guard test (new).**
  - Every class in the served shell and emitted by the client application must exist in the vendored stylesheet or on a short named allowlist. Composed and toggled class names must be covered, not only literals.
  - Every selector in the local stylesheet must be on an explicit allowlist grouped by the ten categories above.
  - Include negative controls: an invented class and an invented selector must each fail.
- **Behaviour tests (new or extended).**
  - Tab hrefs for each view, including filter and receipt reference
  - Unavailable tabs: no `href`, `aria-disabled`, no navigation
  - `.active` and `aria-current` follow the view
  - Plain versus modified click
  - Every tone has a palette mapping, with an unknown tone falling back to warn and never to a reassuring colour
- **Existing tests.** They change only where they name markup that changed: the Factories navigation landmark, and the harness's tab elements and click events. Sink, CSP, local-only, read-only, leak and traversal checks keep their strength. No assertion is removed to make a change pass.
- **Prior art.** The asset hygiene test (served shell, stylesheets and scripts), the sink-scanner negative controls, and the served-app wiring test with its DOM harness.
- **Manual acceptance (browser).** Run against the manual fixture:
  - All seven views at 1280px and 390px, with no horizontal page scroll
  - Keyboard-only use, including the drawer
  - Contrast of every rendered text pair, including pairs not measured above
  - No CSP errors in the console and no external requests
  - Scenario 5: pan/zoom, selection, open details and focus survive a poll
  - Reduced motion
  - Results recorded in the viewer guide with what was actually run

## Out of Scope

- Materialize 2.x, Material 3, dark mode or theme switching
- Materialize JavaScript, Waves, webfonts or an icon font
- Any change to the server, snapshot API, page URLs, CSP, polling or wording
- New views, new data or new controls
- Redesigning the Run graph's layout or interaction
- Automated browser tests or visual regression tooling
- Building Materialize from Sass or purging the vendored stylesheet

## Further Notes

- v1.0.0 is unmaintained. For a local, read-only, CSS-only page that was accepted.
- v1's Waves writes style attributes, which the CSP blocks, and its Sidenav has no focus or ARIA handling. Both support the CSS-only decision.
- v1 rules that surprise: every `<nav>` becomes a 56px pink bar, `select` is hidden unless `browser-default`, `collapsible-body` is hidden by default, collapsible headers drop their focus outline, and disabled transparent tabs look the same as enabled ones.
- Definition-list values keep the browser's default indent. Removing it would be taste, not function.
