# Changelog

## v2.7 — current

WebUI network tuner: per-interface TCP tuning with one-tap profiles, live
telemetry and a saved test history.

**New in 2.7**
- Live **BBR telemetry** on Home.
- **Congestion-control A/B duel** — compare two algorithms head to head.
- **Per-route congestion-control pinning**.
- Optional **Advanced TCP buffers** toggle — raises the socket-buffer ceilings
  to 16 MiB so BBR/CUBIC can fill high-BDP Wi-Fi 6 / 5G links. Raise-only: it
  never lowers a value, so a ROM that already tunes these (e.g. OxygenOS) is
  left untouched. It also raises `tcp_max_reordering` to 1000 (tolerates packet reordering on wide / aggregated Wi-Fi). Off by default.

**Fixes carried from 2.6**
- Manual congestion control + qdisc apply instantly on Force Apply (Wi-Fi).
- The qdisc shown matches what you picked (read from the config, not the
  Android-wrapped live root).
- The profile label clears when you change a setting by hand.
- Settings dropdowns no longer cut off their last option.

## v2.6 / v2.5 — earlier

- Profiles (Gaming / Streaming / Balanced / Battery), multi-server bufferbloat
  test, Ookla-style Results tab, real cellular signal in dBm.
- Per-interface TCP congestion control + qdisc tuning, with automatic
  Wi-Fi / Cellular switching.