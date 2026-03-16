# Plays Ranch Programming Corporation LLC Homepage

This repository contains a premium one-page homepage implementation for PRP with a dark luxury tech style, responsive layout, and a signature animated hero stage.

## Files

- `index.html`: Homepage structure and brand copy
- `styles.css`: Visual system, layout, responsiveness, and logo animation
- `script.js`: Scroll reveal behavior and subtle interactive hero tilt
- `assets/prp-shield-logo.svg`: PRP shield logo asset used in the hero

## Fast updates

- To replace the logo later, update `assets/prp-shield-logo.svg` and keep the same filename.
- To change hero animation intensity, adjust `.hero-emblem`, `.hero-stage__ring--outer`, and `.hero-stage__ring--inner` in `styles.css`.
- To update headline, services, or CTA copy, edit the matching sections in `index.html`.
- To change contact details, update the links in the CTA section and footer inside `index.html`.

## Notes

- Motion respects `prefers-reduced-motion`.
- The hero uses lightweight CSS transforms and a small amount of vanilla JavaScript for performance.
