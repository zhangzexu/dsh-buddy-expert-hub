# Mini Program Responsibility Boundary

This reference does not route mini-program development or maintain any WeChat IDE, DevTools,
installer, download, compilation, simulator, automation, or real-device debugging flow. Those live
in `mini-program-development/references/wechat-devtools.md`.

Use the active owners instead:

- `mini-program-development` owns WorkBuddy mini-program development, native project constraints,
  local validation, preview, WeChat DevTools and real-device debugging, and managed-publishing guidance.
- `cloud-service` owns only the cloud capabilities requested by a mini program: database, auth,
  storage, LLM, diagnostics, privacy metadata, and virtual payment.
- `sites` owns application registration and the WorkBuddy publish/share entry, reusing the existing
  `applicationId`.
- WorkBuddy daemon owns deterministic local source optimization, build, validation, and packaging.
- Genie BaaS and WeChat return authoritative upload, authorization, review, and release results.

Do not add IDE routing or implementation details to this file. Cloud integration details live
in the sibling references linked from `cloud-service/SKILL.md`; development and delivery details live
under `mini-program-development/references/`.
