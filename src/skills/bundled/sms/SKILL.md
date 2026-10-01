---
name: sms
description: Send a text message (SMS) via Twilio. Numbers outside the allowlist need the user's approval.
user-invocable: true
triggers: [sms, text message, send a text]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    to:
      type: string
      description: Recipient number in international format, e.g. +447700900123.
    message:
      type: string
      description: Text to send (max 1600 characters).
  required: [to, message]
metadata:
  openclaw:
    emoji: "\U0001F4AC"
    safety:
      externalWrite: true
      publicCommunication: true
    requires:
      env: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER]
      bins: []
---

# SMS (Twilio)

Sends `message` to `to` from `TWILIO_FROM_NUMBER`.

- Numbers in `PHONE_ALLOWED_NUMBERS` (and `PHONE_OWNER_NUMBER`) are texted
  directly. Any other number returns `APPROVAL_REQUIRED` and the user gets a
  one-tap approval prompt; send again with the same number after they approve.
- Each message is budget-checked and its estimated price is recorded.
- `success` means Twilio accepted the message (status `queued`), not that it
  was delivered.
