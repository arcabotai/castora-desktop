# Castora Desktop

Castora Desktop is a Tauri v2 desktop client for Hypersnap. It is macOS-first
and designed to move to Windows once the read/write spine is stable.

## What Is Implemented

- Vite + React + TypeScript + Tailwind application shell.
- Castora-style desktop layout with feed, compose, account, and network panels.
- Hypersnap read client defaulting to `https://haatz.quilibrium.com`.
- Local signer commands backed by the OS keychain.
- Phase 0 write spike: build a signed Farcaster cast message with a small
  CastAdd protobuf encoder, keep the private key in Rust/keychain, and submit
  raw message bytes through a Tauri command.

## Development

```bash
npm install
npm run dev
npm run test:run
npm run tauri dev
```

## Notes

- V1 targets existing FIDs only.
- New FID registration, custody recovery, media upload infra, DMs, payments,
  and Castora premium/community features are intentionally deferred.
- Test writes with a test FID/signer first. A created desktop signer still needs
  to be approved for the target FID before a hub will accept signed messages.
