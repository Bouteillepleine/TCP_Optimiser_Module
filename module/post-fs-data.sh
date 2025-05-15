#!/system/bin/sh

sleep 2

# Check if BBR is available
if grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control; then
    CONG=bbr
else
    CONG=cubic
fi

# Set congestion control
if command -v sysctl >/dev/null 2>&1; then
    sysctl -w net.ipv4.tcp_congestion_control=$CONG
else
    echo "$CONG" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null
fi

# IPv4 TCP optimizations
echo 1 > /proc/sys/net/ipv4/tcp_ecn 2>/dev/null
echo fq > /proc/sys/net/core/default_qdisc 2>/dev/null
echo 110 > /proc/sys/net/ipv4/tcp_pacing_ca_ratio 2>/dev/null
echo 160 > /proc/sys/net/ipv4/tcp_pacing_ss_ratio 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_window_scaling 2>/dev/null
echo "4096 87380 16777216" > /proc/sys/net/ipv4/tcp_rmem 2>/dev/null
echo "4096 65536 16777216" > /proc/sys/net/ipv4/tcp_wmem 2>/dev/null
echo 16777216 > /proc/sys/net/core/rmem_max 2>/dev/null
echo 16777216 > /proc/sys/net/core/wmem_max 2>/dev/null
echo 4096 > /proc/sys/net/ipv4/tcp_max_syn_backlog 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_mtu_probing 2>/dev/null

# IPv6 TCP tuning
echo 1 > /proc/sys/net/ipv6/tcp_ecn 2>/dev/null
echo "4096 87380 16777216" > /proc/sys/net/ipv6/tcp_rmem 2>/dev/null
echo "4096 65536 16777216" > /proc/sys/net/ipv6/tcp_wmem 2>/dev/null
