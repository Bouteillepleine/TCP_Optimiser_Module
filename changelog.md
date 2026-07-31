# Changelog

## v2.7-68 — fixes

- **Upgrades no longer reset your settings.** The installer only carried over the
  cc/qdisc markers; the Advanced TCP buffers toggle, Smart-cake hints, active
  profile label and the entire Results-tab test history were silently lost on
  every update. All of them are preserved now.

## v2.7-67 — fixes

- Socket buffers are now **raise-only everywhere**. The boot-time block used to
  overwrite `tcp_rmem`/`tcp_wmem` with a fixed `4096 2097152 16777216`, replacing
  the ROM's tuned min/default with a 2 MiB per-socket default and pre-empting the
  Advanced TCP buffers toggle. It now only ever raises the ceiling.
- `tcp_mtu_probing` is set to **1**, not 0. The old value downgraded ROMs (such as
  OxygenOS) that already ship 1, and contradicted the Advanced-buffers path.
- **initcwnd / initrwnd now reach the routes that carry traffic.** They were only
  written to the `main` table, which on Android holds just the on-link LAN route —
  the `default` route lives in the per-interface table. Both tables are covered now,
  matching how congestion-control pinning already worked.
- **qdisc checks match on a word boundary.** `fq` was satisfied by a live `fq_codel`
  (likewise `pfifo` by `pfifo_fast`), so an apply could report success after failing
  and the watchdog would never notice a hijack.
- **VoWiFi detection works on OxygenOS.** The daemon still used the AOSP
  `slot='vowifi'` string, which OxygenOS never prints, so every fresh Wi-Fi
  connection waited out the full 20 s timeout before applying settings.
- **The qdisc watchdog no longer invents a qdisc.** With no marker file it used to
  force `htb` (Wi-Fi) / `multiq` (Cellular) even though the apply path had set no
  qdisc at all; it now guards nothing.
- **VPN interfaces resolve to the physical link.** With a tunnel up, `tun0` was
  treated as Wi-Fi, so the qdisc landed on the tunnel instead of the real
  bottleneck and route pinning silently did nothing.

## v2.7 — earlier

WebUI network tuner: per-interface TCP tuning with one-tap profiles, live
telemetry and a saved test history.

**New in 2.7**
- Live **BBR telemetry** on Home.
- **Congestion-control A/B duel** — compare two algorithms head to head.
- **Per-route congestion-control pinning**.
- **Auto-Optimize** (Tools): probes a few congestion-control + qdisc combos on the
  current connection and applies the best throughput-vs-bufferbloat.
- **Smart cake**: after a bufferbloat test, the cake qdisc is shaped to the
  measured rate + RTT (`bandwidth`/`rtt`/`ack-filter`) instead of running
  unlimited.
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