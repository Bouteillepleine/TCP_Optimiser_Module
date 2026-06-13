#!/system/bin/sh

MODPATH="${0%/*}"
DEBOUNCE_TIME=10
VOWIFI_CONNECT_TIME=10

. "$MODPATH/utils.sh" # Load utils

# Get the list of available congestion control algorithms
congestion_algorithms="$(cat /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null)"

update_description() {
	local iface="$1"
	local algo="$2"
	local icon="⁉️"

	case "$iface" in
		Wi-Fi) icon="🛜" ;;
		Cellular) icon="📶" ;;
		Tunnel) icon="🔐" ;;
	esac

	local desc="TCP Optimisations & update tcp_cong_algo based on interface | iface: $iface $icon | algo: $algo"
	sed -i "s|^description=.*|description=$desc|" "$MODPATH/module.prop"
}

kill_tcp_connections() {
	if [ -f "$MODPATH/kill_connections" ]; then
		log_print "Killing TCP connections due to congestion change"

		if ss -K state established >/dev/null 2>&1; then
			log_print "Killed established TCP connections"
		else
			ss -K >/dev/null 2>&1
			log_print "Killed TCP connections using fallback ss -K"
		fi
	fi
}

set_max_initcwnd_initrwnd() {
	local active_iface="$1"

	if [ -f "$MODPATH/initcwnd_initrwnd" ]; then
		maxBufferSize="$(cat /proc/sys/net/ipv4/tcp_rmem 2>/dev/null | awk '{print $3}')"
		mtu="$(ip link show "$active_iface" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="mtu") print $(i+1)}')"

		[ -z "$maxBufferSize" ] && return
		[ -z "$mtu" ] && return
		[ "$mtu" -le 40 ] && return

		mtu=$((mtu - 40))
		maxInitrwndValue=$((maxBufferSize / mtu))

		local applied
		applied=0

		while IFS= read -r line; do
			[ -z "$line" ] && continue

			run_as_su "/system/bin/ip route change $line initcwnd 10 initrwnd $maxInitrwndValue"
			if [ $? -eq 0 ]; then
				applied=1
			fi
		done <<EOF
$(run_as_su "/system/bin/ip route show | grep \"dev $active_iface\"")
EOF

		if [ "$applied" -eq 1 ]; then
			log_print "Setting initcwnd = 10; initrwnd = $maxInitrwndValue!"
		fi
	fi
}

get_selected_qdisc() {
	local prefix="$1"
	local default_qdisc="fq_codel"
	local marker=""
	local qdisc=""

	marker="$(find "$MODPATH" -maxdepth 1 -type f -name "${prefix}_qdisc_*" -print -quit 2>/dev/null)"
	qdisc="${marker##${MODPATH}/${prefix}_qdisc_}"

	case "$qdisc" in
		fq_codel|fq|pfifo_fast)
			printf '%s\n' "$qdisc"
			;;
		*)
			printf '%s\n' "$default_qdisc"
			;;
	esac
}

get_qdisc_prefix_for_iface() {
	local iface="$1"

	case "$iface" in
		wlan*|swlan*)
			printf '%s\n' "wlan"
			;;

		rmnet*|rmnet_data*|ccmni*|ccmni-lan*|ccmni-wan*)
			printf '%s\n' "rmnet_data"
			;;

		*)
			printf '%s\n' "wlan"
			;;
	esac
}

set_qdisc() {
	local iface="$1"
	local qdisc="$2"

	[ -z "$iface" ] && return 1
	[ -z "$qdisc" ] && qdisc="fq_codel"

	case "$qdisc" in
		fq_codel|fq|pfifo_fast)
			;;
		*)
			log_print "Invalid qdisc requested: $qdisc. Falling back to fq_codel."
			qdisc="fq_codel"
			;;
	esac

	if run_as_su "tc qdisc replace dev $iface root $qdisc"; then
		log_print "Applied qdisc: $qdisc ($iface)"
		return 0
	fi

	if [ "$qdisc" != "fq_codel" ]; then
		log_print "Failed to apply qdisc: $qdisc ($iface). Trying fq_codel fallback."

		if run_as_su "tc qdisc replace dev $iface root fq_codel"; then
			log_print "Applied fallback qdisc: fq_codel ($iface)"
			return 0
		fi
	fi

	log_print "Failed to apply qdisc on $iface"
	return 1
}

apply_selected_qdisc() {
	local iface="$1"
	local prefix=""
	local qdisc=""

	prefix="$(get_qdisc_prefix_for_iface "$iface")"
	qdisc="$(get_selected_qdisc "$prefix")"

	set_qdisc "$iface" "$qdisc"
}

set_congestion() {
	local algo="$1"
	local mode="$2"

	if echo "$congestion_algorithms" | grep -qw "$algo"; then
		echo "$algo" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null
		log_print "Applied congestion control: $algo ($mode)"
		kill_tcp_connections
		update_description "$mode" "$algo"
	else
		log_print "Unavailable algorithm: $algo"
	fi
}

set_tcp_pacing() {
	local ca="$1"
	local ss="$2"

	echo "$ca" > /proc/sys/net/ipv4/tcp_pacing_ca_ratio 2>/dev/null
	echo "$ss" > /proc/sys/net/ipv4/tcp_pacing_ss_ratio 2>/dev/null
}

get_active_iface() {
	ip route show default 2>/dev/null | awk '/default/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}'
}

get_wifi_freq() {
	local iface="$1"

	iw dev "$iface" link 2>/dev/null | grep "freq:" | awk '{print $2}'
}

apply_wifi_settings() {
	local iface="$1"
	local applied=0

	freq="$(get_wifi_freq "$iface")"
	log_print "Wi-Fi band detected: ${freq} MHz"

	if [ -n "$freq" ]; then
		if [ "$freq" -lt 3000 ]; then
			set_tcp_pacing 150 200
		elif [ "$freq" -lt 6000 ]; then
			set_tcp_pacing 200 300
		else
			set_tcp_pacing 250 350
		fi
	fi

	for algo in $congestion_algorithms; do
		if [ -f "$MODPATH/wlan_$algo" ]; then
			set_congestion "$algo" "Wi-Fi"
			apply_selected_qdisc "$iface"
			set_max_initcwnd_initrwnd "$iface"
			applied=1
			break
		fi
	done

	if [ "$applied" -eq 0 ]; then
		set_congestion cubic "Wi-Fi"
		apply_selected_qdisc "$iface"
		set_max_initcwnd_initrwnd "$iface"
	fi

	return "$applied"
}

apply_cellular_settings() {
	local iface="$1"
	local applied=0

	set_tcp_pacing 120 200

	for algo in $congestion_algorithms; do
		if [ -f "$MODPATH/rmnet_data_$algo" ]; then
			set_congestion "$algo" "Cellular"
			apply_selected_qdisc "$iface"
			set_max_initcwnd_initrwnd "$iface"
			applied=1
			break
		fi
	done

	if [ "$applied" -eq 0 ]; then
		set_congestion cubic "Cellular"
		apply_selected_qdisc "$iface"
		set_max_initcwnd_initrwnd "$iface"
	fi

	return "$applied"
}

apply_base_tcp_settings() {
	local default_qdisc=""

	# IPv4 TCP optimizations
	echo 1 > /proc/sys/net/ipv4/tcp_ecn 2>/dev/null

	# Default qdisc should be marker-based, not automatically forced to fq for BBR.
	default_qdisc="$(get_selected_qdisc wlan)"
	echo "$default_qdisc" > /proc/sys/net/core/default_qdisc 2>/dev/null
	log_print "Applied default qdisc: $default_qdisc"

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

	[ -w /proc/sys/net/ipv6/tcp_rmem ] && echo "4096 87380 16777216" > /proc/sys/net/ipv6/tcp_rmem
	[ -w /proc/sys/net/ipv6/tcp_wmem ] && echo "4096 65536 16777216" > /proc/sys/net/ipv6/tcp_wmem
}

# Start Run Code

# On startup, reset description to default
if [ -f "$MODPATH/module.prop" ]; then
	default_desc="TCP Optimisations & update tcp_cong_algo based on interface"
	sed -i "s|^description=.*|description=$default_desc|" "$MODPATH/module.prop"
fi

log_print "TCP Optimiser service started."
log_print "Available congestion algorithms: $congestion_algorithms"

apply_base_tcp_settings

last_mode=""
change_time=0
vowifi_pending=0
vowifi_start_time=0

while true; do
	current_time="$(date +%s)"
	iface="$(get_active_iface)"

	[ -z "$iface" ] && sleep 5 && continue

	new_mode="none"

	case "$iface" in
		wlan*|swlan*) new_mode="Wi-Fi" ;;
		rmnet*|rmnet_data*|ccmni*|ccmni-lan*|ccmni-wan*) new_mode="Cellular" ;;
		tun*) new_mode="Tunnel" ;;
		*) new_mode="none" ;;
	esac

	if [ "$new_mode" != "$last_mode" ] || [ -f "$MODPATH/force_apply" ]; then
		if [ "$((current_time - change_time))" -ge "$DEBOUNCE_TIME" ]; then
			if [ "$new_mode" = "Wi-Fi" ]; then
				vowifi_pending=1
				vowifi_start_time="$current_time"
			elif [ "$new_mode" = "Cellular" ]; then
				vowifi_pending=0
				apply_cellular_settings "$iface"
			elif [ "$new_mode" = "Tunnel" ]; then
				vowifi_pending=0
				log_print "Tunnel interface detected: $iface. Skipping automatic Wi-Fi/Cellular apply."
				update_description "Tunnel" "unchanged"
			fi

			last_mode="$new_mode"
			change_time="$current_time"
			rm -f "$MODPATH/force_apply"
		fi
	fi

	# === Wi-Fi Pending Logic ===
	if [ "$new_mode" = "Wi-Fi" ] && [ "$vowifi_pending" -eq 1 ]; then
		vowifi="$(get_wifi_calling_state)"
		vowifi="${vowifi:-1}"

		if [ "$((current_time - vowifi_start_time))" -ge "$VOWIFI_CONNECT_TIME" ]; then
			log_print "[INFO] VoWiFi timeout reached. Applying Wi-Fi settings..."
			vowifi_pending=0
			apply_wifi_settings "$iface"
		elif [ "$vowifi" -eq 0 ]; then
			log_print "[INFO] VoWiFi activated. Applying Wi-Fi settings..."
			vowifi_pending=0
			apply_wifi_settings "$iface"
		fi
	fi

	sleep 5
done
