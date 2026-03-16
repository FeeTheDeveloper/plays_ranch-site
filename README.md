# Plays Ranch Programming Corporation LLC Homepage

This repository contains a premium one-page homepage implementation for PRP with a dark luxury tech style, responsive layout, and a signature animated hero stage.

## Files

- `index.html`: Homepage structure and brand copy
- `styles.css`: Visual system, layout, responsiveness, and logo animation
- `script.js`: Scroll reveal behavior, hero motion, and real contact form submission flow
- `api/contact.js`: Vercel-compatible contact form handler with validation and email delivery
- `local-preview-server.js`: Lightweight local preview server for the static site and `/api/contact`
- `assets/prp-shield-logo.svg`: PRP shield logo asset used in the hero

## Fast updates

- To replace the logo later, update `assets/prp-shield-logo.svg` and keep the same filename.
- To change hero animation intensity, adjust `.hero-emblem`, `.hero-stage__ring--outer`, and `.hero-stage__ring--inner` in `styles.css`.
- To update headline, services, or CTA copy, edit the matching sections in `index.html`.
- To change contact details, update the links in the CTA section and footer inside `index.html`.

## Notes

- Motion respects `prefers-reduced-motion`.
- The hero uses lightweight CSS transforms and a small amount of vanilla JavaScript for performance.

## Contact form setup

The contact form submits to `/api/contact` and is designed for Vercel deployment.

Required environment variables:

- `RESEND_API_KEY`: API key for your Resend account
- `CONTACT_EMAIL`: Destination inbox for submissions. Set this to `contact@playsranch.com`
- `RESEND_FROM_EMAIL`: Optional override for the sender address. If omitted, the backend uses `Plays Ranch Programming <contact@playsranch.com>`

What each variable does:

- `RESEND_API_KEY`: Authenticates the backend with Resend so the form can actually send mail
- `CONTACT_EMAIL`: The inbox that receives contact form submissions in production
- `RESEND_FROM_EMAIL`: The sender shown on outgoing emails. This must be a verified sender in Resend if you override the default

What the backend does:

- Validates required fields on the frontend and backend
- Validates email format
- Sanitizes user input before sending
- Uses a honeypot field and form-age check for simple anti-spam protection
- Applies a best-effort in-memory rate limit suitable for a minimal Vercel serverless setup

Deployment notes:

- On Vercel, add the environment variables above in the project settings before deploying.
- The serverless handler lives at `api/contact.js`, so Vercel will expose it automatically as `/api/contact`.
- For a full local test of the form flow, set the same environment variables in your shell and run `node .\local-preview-server.js`.
- Production delivery still requires the sender domain used by Resend to be verified. If `playsranch.com` is not verified in Resend, set `RESEND_FROM_EMAIL` to another verified sender address before going live.

## Vercel deployment checklist

Before deploying on Vercel, make sure these are ready:

1. Create a Resend account and generate a live `RESEND_API_KEY`.
2. Decide what inbox should receive submissions. For this project it should be `contact@playsranch.com`, so set `CONTACT_EMAIL=contact@playsranch.com`.
3. Verify the sender domain in Resend for `playsranch.com`, or set `RESEND_FROM_EMAIL` to another verified sender address you control.
4. Add the environment variables in Vercel:
   - `RESEND_API_KEY`
   - `CONTACT_EMAIL`
   - `RESEND_FROM_EMAIL` if needed
5. Deploy the project to Vercel.
6. Submit a real test form from the deployed site and confirm the message arrives at `contact@playsranch.com`.

Recommended Vercel variable values for this site:

- `CONTACT_EMAIL=contact@playsranch.com`
- `RESEND_FROM_EMAIL=Plays Ranch Programming <contact@playsranch.com>` if that sender is verified in Resend

If these variables are missing before deployment:

- No email will be sent without `RESEND_API_KEY`
- Delivery may fail if the sender address is not verified in Resend
- The frontend will show a real error instead of a fake success
