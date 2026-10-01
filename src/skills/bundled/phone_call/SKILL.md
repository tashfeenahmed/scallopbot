---
name: phone_call
description: Place an outbound phone call (Twilio) that speaks a message, and optionally collects the callee's spoken or keypad reply. Numbers outside the allowlist need the user's approval.
user-invocable: true
triggers: [call, phone, ring, phone call]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    to:
      type: string
      description: Number to call in international format, e.g. +447700900123.
    message:
      type: string
      description: What to say on the call, written as speech (max 1000 characters). Say who is calling on whose behalf.
    wait_for_reply:
      type: boolean
      description: Ask the callee for a spoken/keypad reply and pass it back to the user in chat. Needs PUBLIC_BASE_URL.
  required: [to, message]
metadata:
  openclaw:
    emoji: "\U0001F4DE"
    safety:
      externalWrite: true
      publicCommunication: true
    requires:
      env: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER]
      bins: []
---

# Phone call (Twilio)

Calls `to` from `TWILIO_FROM_NUMBER` and speaks `message`.

- Numbers in `PHONE_ALLOWED_NUMBERS` (and `PHONE_OWNER_NUMBER`) are called
  directly. Any other number returns `APPROVAL_REQUIRED` and the user gets a
  one-tap approval prompt; call again with the same number after they approve.
  Never ask twice.
- With `PUBLIC_BASE_URL` set, the call uses ScallopBot's own TTS voice when
  available, and `wait_for_reply: true` collects the callee's reply, which is
  posted back to the user in chat. Without it, Twilio's built-in voice is used
  and no reply is collected.
- Each call is budget-checked and its estimated price is recorded.
- `success` means Twilio accepted the call (status `queued`), not that someone
  answered. Say so to the user.
