# Changelog

All notable changes to ClearAir Together. Dates are UTC.

## 2026-11-28: Stricter checks and accessibility

- Server code now passes typescript-eslint's `strictTypeChecked` rules. Route registration is synchronous where
  nothing is awaited, and the CSRF check is a pure function used by a callback-style hook.
- Zod updated to its current APIs (`z.uuid()`, `z.url()`, `z.email()`, `z.iso.datetime()`, `.loose()`, `error:`).
- Removed every non-null assertion and double cast; values are narrowed with real checks instead.
- Malformed WebSocket frames are decoded safely whatever buffer shape arrives; voice setup failures are logged.
- Every exported function and class has a doc comment.
- Accessibility: form errors are linked to their fields with `aria-describedby`, invalid fields are marked with
  `aria-invalid` and receive focus, and the gauge and status chips stay distinct in forced-colours (high contrast) mode.
- Added the MIT `LICENSE` file.

## 2026-11-27: Plants and maintainability

- Plants page with illustrated suggestions and a Gemini plant chat that falls back to the assistant model when Gemini
  is slow. Removed the camera and sensor features.
- Split the API into one route module per feature and the frontend into one module per view.
- Broke up the most complex functions; ESLint now enforces complexity ≤ 10, functions ≤ 60 lines, files ≤ 300 lines,
  ≤ 4 parameters and nesting ≤ 3.
- One shared HTTP helper for the Ollama, Anthropic and Gemini providers.
- Browser code is type-checked; CI enforces coverage thresholds. Added architecture and contributor docs.
- Fixed the skip link, which changed the URL hash and let the view router move focus away from the content.

## 2026-11-26: First release

- Verified-only Google Air Quality readings with honest freshness states, household plans, routine comparison with
  separate exposure and emissions, a schema-validated and safety-checked assistant, and k-anonymous community
  challenges.
- Ollama Cloud (Gemma 4) assistant with Claude as an alternative, email and Google sign-in, a menu-based interface
  with a car-style gauge, and Gemini Live voice.
