#!/system/bin/sh

sleep 2

# Mount debugfs (Android 11+ user builds leave it unmounted) so the WebUI
# telemetry card can read /sys/kernel/debug/tcp_bbr3/sockets. Idempotent.
mountpoint -q /sys/kernel/debug 2>/dev/null || \
	mount -t debugfs debugfs /sys/kernel/debug 2>/dev/null

AVAIL_CC="$(cat /proc/sys/net/ipv4/tcp_available_congestion_control)"
# Check if BBR3 is available
if echo "$AVAIL_CC" | grep -qw bbr3; then
    CONG="bbr3"
# Check if BBR is available
elif echo "$AVAIL_CC" | grep -qw bbr; then
    CONG="bbr"
else
	CONG="cubic"
fi

# Set congestion control
if command -v sysctl >/dev/null 2>&1; then
	sysctl -w net.ipv4.tcp_congestion_control=$CONG
else
	echo "$CONG" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null
fi

# IPv4 TCP optimizations
echo 1 > /proc/sys/net/ipv4/tcp_ecn 2>/dev/null
echo "fq_codel" > /proc/sys/net/core/default_qdisc 2>/dev/null
echo 120 > /proc/sys/net/ipv4/tcp_pacing_ca_ratio 2>/dev/null
echo 180 > /proc/sys/net/ipv4/tcp_pacing_ss_ratio 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_window_scaling 2>/dev/null

# Socket buffers: RAISE ONLY. The old code wrote a fixed "4096 2097152 16777216"
# over tcp_rmem/tcp_wmem, which replaces the ROM's tuned min & default (OxygenOS
# ships 524288 1048576 16777216) with a 2 MiB default on every socket. That is
# exactly what apply_tcp_buffers() in service.sh was written to avoid, so use the
# same raise-only rule here and let the "Advanced TCP buffers" toggle stay
# meaningful instead of being pre-empted by this block.
for f in /proc/sys/net/core/rmem_max /proc/sys/net/core/wmem_max; do
	cur=$(cat "$f" 2>/dev/null)
	[ -n "$cur" ] && [ "$cur" -lt 16777216 ] && echo 16777216 > "$f" 2>/dev/null
done
for f in /proc/sys/net/ipv4/tcp_rmem /proc/sys/net/ipv4/tcp_wmem \
         /proc/sys/net/ipv6/tcp_rmem /proc/sys/net/ipv6/tcp_wmem; do
	set -- $(cat "$f" 2>/dev/null)
	[ -n "$3" ] && [ "$3" -lt 16777216 ] && echo "$1 $2 16777216" > "$f" 2>/dev/null
done

echo 4096 > /proc/sys/net/ipv4/tcp_max_syn_backlog 2>/dev/null
# PMTU probing: OxygenOS already ships 1; writing 0 here downgraded the ROM on
# every boot (and fought apply_tcp_buffers, which sets 1).
echo 1 > /proc/sys/net/ipv4/tcp_mtu_probing 2>/dev/null
echo 16384 > /proc/sys/net/ipv4/tcp_notsent_lowat 2>/dev/null

# IPv6 TCP tuning
echo 1 > /proc/sys/net/ipv6/tcp_ecn 2>/dev/null

# Extra settings for optimal stability
echo 100000 > /proc/sys/net/core/netdev_max_backlog 2>/dev/null
echo 3 > /proc/sys/net/ipv4/tcp_fastopen 2>/dev/null
echo 917504 > /proc/sys/net/core/rmem_default 2>/dev/null
echo 917504 > /proc/sys/net/core/wmem_default 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_autocorking 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_fack 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_dsack 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_sack 2>/dev/null
echo 0 > /proc/sys/net/ipv4/tcp_collapse_max_bytes 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_recovery 2>/dev/null

# High-Yield Network Jitter & Continuity Tweaks
echo 0 > /proc/sys/net/ipv4/tcp_slow_start_after_idle 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_no_metrics_save 2>/dev/null
echo 204800 > /proc/sys/net/core/optmem_max 2>/dev/null
echo 10000 > /proc/sys/net/ipv4/tcp_rto_max 2>/dev/null
echo 2 > /proc/sys/net/ipv4/tcp_early_retrans 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_thin_linear_timeouts 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_thin_dupack 2>/dev/null
echo 300 > /proc/sys/net/ipv4/tcp_keepalive_time 2>/dev/null
echo 15 > /proc/sys/net/ipv4/tcp_keepalive_intvl 2>/dev/null
echo 5 > /proc/sys/net/ipv4/tcp_keepalive_probes 2>/dev/null

# Protective Load Balancing (PLB) Real-Time Rerouting
echo 1 > /proc/sys/net/ipv4/tcp_plb_enabled 2>/dev/null
echo 2 > /proc/sys/net/ipv4/tcp_plb_idle_retransmit_rounds 2>/dev/null
echo 3 > /proc/sys/net/ipv4/tcp_plb_retransmit_threshold 2>/dev/null
