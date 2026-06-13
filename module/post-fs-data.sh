#!/system/bin/sh

sleep 2

# Check if BBRv3/BBR is available
AVAILABLE_CONG="$(cat /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null)"

if echo "$AVAILABLE_CONG" | grep -qw bbrv3; then
	CONG=bbrv3
elif echo "$AVAILABLE_CONG" | grep -qw bbr; then
	CONG=bbr
else
	CONG=cubic
fi

# Set congestion control
if command -v sysctl >/dev/null 2>&1; then
	sysctl -w net.ipv4.tcp_congestion_control="$CONG" >/dev/null 2>&1
else
	echo "$CONG" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null
fi

# Select default qdisc
# BBR/BBRv3 generally works best with fq. For non-BBR, fq_codel is a modern fallback.
case "$CONG" in
	bbr|bbrv3)
		echo "fq" > /proc/sys/net/core/default_qdisc 2>/dev/null
		;;
	*)
		echo "fq_codel" > /proc/sys/net/core/default_qdisc 2>/dev/null
		;;
esac

# IPv4 TCP optimizations
echo 1 > /proc/sys/net/ipv4/tcp_ecn 2>/dev/null
echo 150 > /proc/sys/net/ipv4/tcp_pacing_ca_ratio 2>/dev/null
echo 200 > /proc/sys/net/ipv4/tcp_pacing_ss_ratio 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_window_scaling 2>/dev/null
echo "4096 87380 16777216" > /proc/sys/net/ipv4/tcp_rmem 2>/dev/null
echo "4096 65536 16777216" > /proc/sys/net/ipv4/tcp_wmem 2>/dev/null
echo 16777216 > /proc/sys/net/core/rmem_max 2>/dev/null
echo 16777216 > /proc/sys/net/core/wmem_max 2>/dev/null
echo 4096 > /proc/sys/net/ipv4/tcp_max_syn_backlog 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_mtu_probing 2>/dev/null

# IPv6 TCP tuning
[ -w /proc/sys/net/ipv6/tcp_ecn ] && echo 1 > /proc/sys/net/ipv6/tcp_ecn

# These paths usually do not exist on many Android/Linux kernels.
# Keep them guarded so unsupported kernels do not waste writes or produce errors.
[ -w /proc/sys/net/ipv6/tcp_rmem ] && echo "4096 87380 16777216" > /proc/sys/net/ipv6/tcp_rmem
[ -w /proc/sys/net/ipv6/tcp_wmem ] && echo "4096 65536 16777216" > /proc/sys/net/ipv6/tcp_wmem
