# Email

Every email HACA Forge sends goes through one module, `apps/api/src/lib/email/`, and uses one branded layout. For now the emails go out through Gmail SMTP with an app password. Later, Resend can replace Gmail by changing env vars only.

## How it works

| File | What it does |
| --- | --- |
| `lib/email/index.js` | `sendEmail({ to, template, data })` renders a template and delivers it. If a send fails, it waits about 1.5s and retries once. It never throws, so check `ok` on the result. `sendEmailOrFail` is the same but throws `EMAIL_SEND_FAILED` (503, "We couldn't send the email. Try again.") when both tries fail. It also holds the throttle and the startup check. |
| `lib/email/drivers.js` | The drivers: `console`, `smtp`, and a marked place for `resend` (not built yet). |
| `lib/email/layout.js` | The one layout. Builds the HTML and plain-text versions from the same content blocks, and escapes all text. |
| `lib/email/templates.js` | Every template, each with sample data. |
| `lib/queue.js` `enqueueEmail` | Notification emails are delivered directly via the configured email driver (Gmail SMTP / console) with automatic retry. |
| `modules/notifications/email.js` | `sendNotificationEmail` is used for overdue, blocked and reminder emails. It skips anyone who turned off email for that category in Settings → Notifications. |

Failures are logged with the error message and code, never the SMTP password, and a failure never crashes a request. Verification codes, phone codes and password resets show the user "We couldn't send the email. Try again." when both tries fail. Every other email fails quietly, and the failure is logged.

**Rate safety.** Each address gets at most one email of each of these types per minute: phone code (`phone_otp`) and password reset (`password_reset`). The limit is counted per API process, in memory.
- A repeat phone code request inside the minute gets `429 OTP_COOLDOWN` and the wait time.
- A repeat reset request gets the usual "If an active account exists…" answer and sends nothing.
- A failed send does not start the minute, so the user can try again at once.

## Env vars

| Var | Value |
| --- | --- |
| `EMAIL_DRIVER` | `console` (default): logs recipient, subject and a short preview, and sends nothing. `smtp`: sends with Nodemailer. `resend`: refused at startup until it is built. |
| `EMAIL_FROM` | Sender, e.g. `HACA Forge <hacaforge@gmail.com>`. With Gmail it must be the Gmail address (or a verified "Send mail as" alias). |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` (SSL) or `587` (STARTTLS) |
| `SMTP_SECURE` | `true` for 465, `false` for 587 |
| `SMTP_USER` | The Gmail address |
| `SMTP_PASS` | The 16-character app password |
| `EMAIL_LOGO_URL` | Optional PNG for the email header. Empty uses the "HACA FORGE" text wordmark. SVG is refused, because most email apps don't show it. |
| `PHONE_OTP_CHANNEL` | `email` (default). `sms` is refused at startup until an SMS provider exists. |
| `FRONTEND_URL` | Used for the links in emails and the app URL in the footer. |

**Startup checks:**
- With `EMAIL_DRIVER=smtp` and any `SMTP_*` setting or `EMAIL_FROM` missing, the API and the worker exit and list the missing names (never values).
- Once started, they check the SMTP connection and log "SMTP connection verified" or "SMTP connection check failed", with host and port only. A failed check is logged but does not stop the server.

Tests always use the console driver (set in `apps/api/vitest.config.js`), whatever `apps/api/.env` says, so tests never send real email.

## Gmail app password setup

1. Use the Google account that will send the email, e.g. a shared `hacaforge@gmail.com`.
2. Turn on 2-Step Verification: Google Account → Security → 2-Step Verification.
3. Create an app password: Google Account → Security → App passwords (or visit `myaccount.google.com/apppasswords`). Name it "HACA Forge" and copy the 16 characters.
4. Set `EMAIL_DRIVER=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` (the address), `SMTP_PASS` (the app password, spaces optional) and `EMAIL_FROM` in `apps/api/.env` (local) or the Render dashboard (both the API and the worker).
5. Check it: `node scripts/send-test-email.js --to=you@example.com`.

If you change the account password, Google revokes its app passwords; create a new one.

**Gmail limits.** A normal Gmail account can send about **500 emails a day** (Google Workspace allows about 2,000). Over the limit, Gmail refuses to send for up to 24 hours. Each failed email is logged, and codes and resets show the friendly error. That is enough for the team's codes, resets and notifications, but not for anything bulk. Move to Resend before the volume grows.

## Templates

All templates use the same layout:
- **Card:** a 600px centered card, built with tables and inline CSS so it renders in Gmail, Outlook, Apple Mail and phone apps. Light page, white card, black primary button, greys from docs/UI.md.
- **Header:** the "HACA FORGE" wordmark (or the PNG logo).
- **Body:** a title, a short intro line, the content, at most one primary button, and an optional secondary link.
- **Footer:** "You're receiving this because you have a HACA Forge account.", "Haris & Co Academy" and the app URL. Notification emails also link to notification settings (`/settings?tab=notifications`).
- **Built in:** a hidden preheader per email; colors set explicitly so dark mode stays readable; a plain-text version of every email; all user text escaped.

| Template | Sent when |
| --- | --- |
| `verificationCode` | Ready for an account or sign-in code. Nothing sends it yet, because there is no sign-in code flow. |
| `phoneVerificationCode` | `POST /api/me/phone-otp/send` |
| `passwordReset` | Forgot password (link valid 48 hours) |
| `accessRequestReceived` | A new access request (to every approver) |
| `accessApproved` | An access request approved (set-password link, 48 hours) |
| `accessRejected` | An access request rejected |
| `accessInfoNeeded` | An admin asks the requester for more information |
| `welcome` | Ready for account creation. Nothing sends it yet: admin-created accounts get no email today. |
| `passwordChanged` | Security notice after a password change (always sent) |
| `changeRequest` | A work details change request (to admins) |
| `notification` | Overdue (owner and SM managers), blocked waiting on you, and blocker reminders: title, message, item name and an "Open in HACA Forge" button |
| `test` | `scripts/send-test-email.js` |

Codes are shown large and spaced, with how long they're valid and "If you didn't request this, ignore this email." Codes never appear in subject lines.

Review waiting, changes requested, approved, pause and help requests are in-app notifications only and send no email. To email one of them, call `sendNotificationEmail` where the in-app notification is created.

## Preview page

In development, open **`/dev/emails`** in the web app (`npm run dev`). It shows every template with its sample data, at desktop or phone width, plus its plain-text version. The API renders them at `GET /api/dev/emails`.
- The web route exists only when `import.meta.env.DEV` is true, so it is not in production builds.
- The API route is not mounted when `NODE_ENV=production`.

## Sending a test email

```
node scripts/send-test-email.js --to=you@example.com                       # the "test" template
node scripts/send-test-email.js --to=you@example.com --template=passwordReset
EMAIL_DRIVER=console node scripts/send-test-email.js --to=you@example.com   # logs it, sends nothing
```

Any template name works and is sent with its sample data. The script exits with code 1 if the email was not sent.

## Phone verification by email

**Off for now.** `PHONE_VERIFICATION_REQUIRED` in `@mmp/shared` is `false`: the mobile number is entered directly on the profile and saved without a code (marked not verified). The Edit Profile dialog shows no badge, Send code button or code box. Everything below stays in place; set the switch to `true` to require it again.

When it is on, adding or changing a phone number on the profile needs a 6-digit code. The code goes to the user's **registered email**, not by SMS.

1. `POST /api/me/phone-otp/send { phone }` validates the number and emails the code using `phoneVerificationCode`. The email shows the number being added, masked except the last 4 digits (`+••••••••3210`).
   - The answer includes `sentTo: "m•••@harisandcoacademy.com"`, `resendAfterSeconds: 60` and the message "We sent a 6-digit code to m•••@harisandcoacademy.com". The profile screen shows that message and a "Resend in Ns" countdown.
2. `POST /api/me/phone-otp/verify { phone, otp }` works as before.
   - Limits: a 10-minute expiry and at most 5 wrong tries, after which the user requests a new code.
   - It returns a verification token and `verifiedVia: 'email'`.
3. `PATCH /api/me/profile { phone, phoneVerificationToken }` saves the number as before. It also records `phoneVerifiedVia: 'email'` on the person.

If the email can't be sent, the code is discarded, the user sees "We couldn't send the email. Try again." and can retry at once. The code is no longer written to the logs. In development the console driver's preview line includes it.

The SMS path (`sendPhoneOtpBySms` in `modules/profile/service.js`) is kept but unused. To bring SMS back: add a provider, send from that function, and allow `PHONE_OTP_CHANNEL=sms` in `emailSettingsProblems` (`config/env.js`).

## Switching to Resend later

1. Install `resend` in `apps/api`.
2. In `lib/email/drivers.js`, replace `createResendDriver` with a driver whose `send(message)` calls `resend.emails.send(message)` and returns `{ messageId }` (the comment there shows the shape).
3. In `config/env.js`, add `RESEND_API_KEY` to the schema, require it for `EMAIL_DRIVER=resend` in `emailSettingsProblems`, and remove the "not built yet" refusal.
4. In Render, set `EMAIL_DRIVER=resend`, `RESEND_API_KEY` and an `EMAIL_FROM` on a domain verified in Resend. Remove the `SMTP_*` values.

Templates, retry, throttle and callers don't change.
