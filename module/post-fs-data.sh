#!/system/bin/sh

sleep 2

MODDIR="${0%/*}"
LOG_FILE="$MODDIR/service.log"

log_msg() {
	mkdir -p "$MODDIR" 2>/dev/null
	touch "$LOG_FILE" 2>/dev/null
	chmod 644 "$LOG_FILE" 2>/dev/null

	echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"

	if [ "$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 200 ]; then
		tail -n 200 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
		chmod 644 "$LOG_FILE" 2>/dev/null
	fi
}

write_sysctl_path() {
	local path="$1"
	local value="$2"

	if [ -w "$path" ]; then
		echo "$value" > "$path" 2>/dev/null && return 0
	fi

	return 1
}

set_sysctl() {
	local key="$1"
	local value="$2"
	local path="/proc/sys/$(echo "$key" | tr '.' '/')"

	if command -v sysctl >/dev/null 2>&1; then
		sysctl -w "$key=$value" >/dev/null 2>&1 && return 0
	fi

	write_sysctl_path "$path" "$value"
}

get_best_cong() {
	local available=""

	available="$(cat /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null)"

	if echo "$available" | grep -qw bbrv3; then
		printf '%s\n' "bbrv3"
	elif echo "$available" | grep -qw bbr; then
		printf '%s\n' "bbr"
	else
		printf '%s\n' "cubic"
	fi
}

get_selected_qdisc() {
	local prefix="$1"
	local default_qdisc="fq_codel"
	local marker=""
	local qdisc=""

	marker="$(find "$MODDIR" -maxdepth 1 -type f -name "${prefix}_qdisc_*" -print -quit 2>/dev/null)"
	qdisc="${marker##${MODDIR}/${prefix}_qdisc_}"

	case "$qdisc" in
		fq_codel|fq|pfifo_fast)
			printf '%s\n' "$qdisc"
			;;
		*)
			printf '%s\n' "$default_qdisc"
			;;
	esac
}

CONG="$(get_best_cong)"

log_msg "Early TCP tuning started."
log_msg "Available congestion algorithms: $(cat /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null)"
log_msg "Selected global congestion algorithm: $CONG"

# Set global congestion control.
if set_sysctl "net.ipv4.tcp_congestion_control" "$CONG"; then
	log_msg "Set net.ipv4.tcp_congestion_control=$CONG"
else
	log_msg "Failed to set net.ipv4.tcp_congestion_control=$CONG"
fi

# Select global default qdisc from marker if available.
# Prefer Wi-Fi marker as general default, but always fall back to fq_codel.
DEFAULT_QDISC="$(get_selected_qdisc wlan)"

if set_sysctl "net.core.default_qdisc" "$DEFAULT_QDISC"; then
	log_msg "Set net.core.default_qdisc=$DEFAULT_QDISC"
else
	log_msg "Failed to set net.core.default_qdisc=$DEFAULT_QDISC"
fi

# IPv4 TCP optimizations.
set_sysctl "net.ipv4.tcp_ecn" "1"
set_sysctl "net.ipv4.tcp_pacing_ca_ratio" "150"
set_sysctl "net.ipv4.tcp_pacing_ss_ratio" "200"
set_sysctl "net.ipv4.tcp_window_scaling" "1"
set_sysctl "net.ipv4.tcp_rmem" "4096 87380 16777216"
set_sysctl "net.ipv4.tcp_wmem" "4096 65536 16777216"
set_sysctl "net.core.rmem_max" "16777216"
set_sysctl "net.core.wmem_max" "16777216"
set_sysctl "net.ipv4.tcp_max_syn_backlog" "4096"
set_sysctl "net.ipv4.tcp_mtu_probing" "1"

# IPv6 TCP tuning.
[ -w /proc/sys/net/ipv6/tcp_ecn ] && echo 1 > /proc/sys/net/ipv6/tcp_ecn 2>/dev/null

# These paths usually do not exist on many Android/Linux kernels.
# Keep them guarded so unsupported kernels do not waste writes or produce errors.
[ -w /proc/sys/net/ipv6/tcp_rmem ] && echo "4096 87380 16777216" > /proc/sys/net/ipv6/tcp_rmem 2>/dev/null
[ -w /proc/sys/net/ipv6/tcp_wmem ] && echo "4096 65536 16777216" > /proc/sys/net/ipv6/tcp_wmem 2>/dev/null

log_msg "Early TCP tuning completed."
