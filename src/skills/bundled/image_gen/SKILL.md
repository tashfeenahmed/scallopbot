---
name: image_gen
description: Generate a new image from a text prompt, or edit an existing image (pass image_path). Saves it under output/ and sends it to the user on the current channel. Costs money and counts toward the daily/monthly budget.
user-invocable: true
triggers: [image, picture, draw, illustration, generate image, edit image, logo, photo edit]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    prompt:
      type: string
      description: What to draw, or for an edit, what to change. Be specific about subject, style, composition and colours.
    image_path:
      type: string
      description: Optional. Path (inside the workspace) of a .png/.jpg/.webp to edit, e.g. a photo the user sent (its saved path is given in the message). Omit to generate from scratch.
    size:
      type: string
      enum: ["1024x1024", "1536x1024", "1024x1536"]
      description: Square (default), landscape or portrait.
    quality:
      type: string
      enum: [low, medium, high]
      description: OpenAI only. Higher costs more; default medium.
    caption:
      type: string
      description: Optional short caption sent with the image.
    deliver:
      type: boolean
      description: Send the image to the user (default true). Set false to only save it.
  required: [prompt]
metadata:
  openclaw:
    emoji: "\U0001F3A8"
    requires:
      bins: []
---

# Image generation

Creates or edits one image per call with the configured provider:

- `IMAGE_GEN_PROVIDER` = `openai` | `fal` | `openrouter`; when unset, the first
  of OpenAI (`OPENAI_API_KEY`), FAL (`FAL_KEY`), OpenRouter (`OPENROUTER_API_KEY`)
  that has a key is used.
- Defaults: OpenAI `gpt-image-1`; FAL `fal-ai/flux/schnell` (edits use
  `fal-ai/flux-pro/kontext`); OpenRouter `google/gemini-2.5-flash-image`.
  Override with `IMAGE_GEN_MODEL` / `IMAGE_GEN_EDIT_MODEL`.

Behaviour:

1. The budget is checked first. If the daily or monthly budget is used up, the
   call is refused with `BUDGET_EXCEEDED`: tell the user, do not retry.
2. The image is saved to `output/image-<timestamp>-<slug>.<ext>` and its cost is
   recorded in the cost tracker.
3. It is sent to the user straight away (Telegram photo, web chat preview).
   The result says `delivered: true`; do not call `send_file` again.

To edit a photo the user sent, pass the saved path from their message as
`image_path` and describe the change in `prompt`.
