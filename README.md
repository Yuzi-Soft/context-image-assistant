# Context Image Assistant

A SillyTavern extension that analyzes current chat context with an LLM, produces image-generation JSON candidates, and integrates with ComfyUI image generation.

## Features

- Manual or automatic candidate analysis per assistant message
- Optional auto image generation
- Custom LLM endpoint/model/api-key configuration
- Context window/length controls
- Candidate JSON embed in message + in-message action buttons
- Prompt view/edit before generation
- Cancel analysis / cancel image generation
- API profile save/load

## Install (SillyTavern)

1. Copy this folder to:
   `SillyTavern/public/scripts/extensions/third-party/context-image-assistant`
2. Restart SillyTavern.
3. Open Extensions and enable **Context Image Assistant**.

## Files

- `manifest.json`
- `index.js`
- `settings.html`
- `style.css`

## Notes

- Requires SillyTavern image generation configured for ComfyUI when generating images.
- Keep backups enabled for chat/settings safety.
