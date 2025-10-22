# Pulse Changelog
All notable changes to **Pulse** are documented in this file.  
This project follows [Semantic Versioning](https://semver.org/).

---

## [1.3] - 2025-10-22
### Added
- Introduced unified **`pulse_type`** field (`anon`, `session`, `lead`) across all events for simpler querying and event stitching in Fabric.
- Implemented automatic cleanup of duplicate attribution fields (`utm_*`, `tid`, `tid_p`) from `form_data`, ensuring each appears once at the top level.
- Improved payload consistency and structure alignment across all event types.

### Changed
- Standardised key naming: replaced `tidp` → `tid_p` for consistency with form schema.
- Refined `serializeForm()` to exclude redundant metadata and retain only user-entered fields.
- Minor internal refactoring for readability and schema alignment.

---

## [1.2] - 2025-10-21
### Changed
- **Transport layer:** Replaced AJAX (`fetch` with CORS) with **Beacon-based submission** using `navigator.sendBeacon()` and `fetch(..., { mode: "no-cors" })` fallback.  
  → This change removes CORS dependencies and mirrors GA4-style beacon sending.
- Simplified `sendJSON()` to be fully fire-and-forget — no longer waits for or parses responses.
- Updated console messages for clarity on beacon success/fallback.

### Fixed
- Cross-origin `Access-Control-Allow-Origin` errors when posting to n8n Cloud.
- Rare session reinitialisation issues triggered after delayed consent.

---

## [1.1] - 2025-09-30
### Added
- **Stable tracking release** with consent gating and hybrid ID model.
- Emits both `anon` and `session` events on first visit or session timeout.
- Adds **form submission tracking**, including hidden ID injection for backend linkage.
- Implements cookie + `localStorage` synchronisation for consistent identifiers.

### Changed
- Introduced script tag config parameters:  
  `data-base`, `data-mode`, `data-site`, and session timeout overrides.
- Improved cookie expiry handling and session timeout refresh.

---

## [1.0] - 2025-09-15
### Added
- Initial proof-of-concept build of Pulse tracking layer.
- Basic anon/session ID generation (`uuidv4`).
- Simple cookie utilities and logging scaffolding.
- Early test hooks for future consent gating and event stitching.
