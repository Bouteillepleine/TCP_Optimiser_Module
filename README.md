# TCP Optimiser

A Magisk / KernelSU module that tunes **per-interface TCP congestion control and
qdisc** with a WebUI: one-tap Profiles, a multi-server bufferbloat/speed test, a
saved Results history, live BBR telemetry, a congestion-control A/B duel and an
optional Advanced TCP buffers toggle.

## Build

Push to `main` (or tag `v*`) — the GitHub Actions workflow packages the flashable
zip `TCP_Optimiser-<version>-<versionCode>.zip` from the module files at the
archive root. A tag also publishes a release + `update.json`.

## Install

Flash the zip in the Magisk / KernelSU manager and reboot. Open the module's
WebUI to configure.