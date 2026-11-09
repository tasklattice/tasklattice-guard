# TaskLattice product identity

Guard and Veritas share the TaskLattice website's existing lattice mark. Guard uses `controller/src/components/brand-logo.tsx` for its sidebar, sign-in page and documentation header. The mark is 32 px; the single-line wordmark uses semibold TaskLattice and a muted, medium-weight Guard suffix. Product typography and the existing shell dimensions remain unchanged. Collapsing the sidebar hides the wordmark and retains the mark and accessible home-link name.

The favicon at `controller/public/assets/brand/tasklattice-mark.svg` and the compatibility copy at `controller/public/favicon.svg` are unchanged copies of the website asset, also used by Veritas. Their SHA-256 is `eeadcc4e7b5b831e961c0d3c7ffa99bab69da33e33bb434231be0a5ce1a1b6ac`. The new favicon URL avoids retaining the previous shield in browser caches. Brand colors use the website's teal signal on light surfaces and cyan on dark or primary surfaces. Guard's existing forced-light application theme is retained.

## Desktop verification — 2026-10-21

The UI build and TypeScript app checks passed, along with 49 existing sidebar, layout and documentation tests. No new tests or dependencies were added for this visual change. On the running local Guard at `http://localhost:38081`, the expanded sidebar showed the shared 32 px mark and aligned single-line name, with no document overflow at 1270 × 1562. The collapsed sidebar retained the mark. The sign-in page was inspected without changing the existing localhost session. No mobile styling or mobile verification was performed.

The standard controller image build could not retrieve Node's base-image metadata because Docker Hub's TLS connection timed out. The local development refresh therefore copied the verified production UI output onto the cached controller image and rolled only the controller deployment. The previous local image is retained as `ghcr.io/tasklattice/tali-guard-controller:dev-before-tasklattice-brand-20261021`. Backend files, runtime image and deployment configuration were retained. Source changes remain compatible with the standard Dockerfile for the next complete build.

Focused prototype review: product intent, shell hierarchy, asset provenance and brand geometry passed; craft and interaction checks cover the observed desktop layouts and collapse control, with keyboard traversal and the documentation header's browser appearance not separately exercised. Using Product Console weights 22/22/14/18/16/8 and scoped dimension scores 10/10/8.33/10/8.33/10 gives 9.50/10; no blocker was observed for the logo change.

Evidence: [sidebar](screenshots/tasklattice-brand-sidebar.png), [sign-in](screenshots/tasklattice-brand-login.png).
