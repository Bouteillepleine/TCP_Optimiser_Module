# TCP Optimiser v2.4

## What's Changed

- Added support for **CCMNI interface devices**.
- Fixed **Wi-Fi Calling** issues affecting certain devices.
- Disabled aggressive TCP pacing to improve long-term connection stability.
- Set the root qdisc to **fq_codel** when BBR/BBRv3 is selected.
- Added dynamic `tcp_pacing_ratios` based on interface type and frequency bandwidth.
- Added **MMRL insets** support for improved WebUI layout compatibility.
- Added **KernelSU Next / KSUN banner** support.

## Note

The root qdisc is now set to `fq_codel` instead of `fq`, even when BBR or BBRv3 is selected.

This is intentional because `fq` may cause Wi-Fi Calling to stop working over time on some devices. Using `fq_codel` provides better long-term compatibility while preserving the module’s TCP optimization behavior.
