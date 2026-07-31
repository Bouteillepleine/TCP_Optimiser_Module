#!/system/bin/sh

MODPATH="${0%/*}"
DEBOUNCE_TIME=5
VOWIFI_CONNECT_TIME=20

. $MODPATH/utils.sh # Load utils

# Get the list of available congestion control algorithms
congestion_algorithms=$(cat /proc/sys/net/ipv4/tcp_available_congestion_control)

CURRENT_ALGO=""
CURRENT_QDISC=""

update_description() {
	local iface="$1"
	local icon="⁉️" label="$iface"

	case "$iface" in
		Wi-Fi) icon="🛜" ;;
		Cellular) icon="📶" ;;
		none) icon="✈️"; label="Offline" ;;
	esac

	# live status shown on the module card in the KernelSU / SukiSU manager
	local extra=""
	if [ "$iface" = "Wi-Fi" ]; then
		local wi=$(dumpsys wifi 2>/dev/null | grep -m1 'mWifiInfo SSID')
		local spd=$(echo "$wi" | sed -n 's/.*Max Supported Tx Link speed: \([0-9]*\)Mbps.*/\1/p')
		local rssi=$(echo "$wi" | sed -n 's/.*RSSI: \(-*[0-9][0-9]*\).*/\1/p')
		[ -n "$spd" ] && extra="$extra · ${spd} Mbps"
		[ -n "$rssi" ] && extra="$extra · ${rssi} dBm"
	elif [ "$iface" = "Cellular" ]; then
		# active-data SIM signal + RAT, same logic as the WebUI (getCellSignalDbm)
		local celld csig crat csub cdbm
		celld=$(dumpsys telephony.registry 2>/dev/null)
		csig=$(echo "$celld" | awk '/mSignalStrength=SignalStrength/{s=$0} /mDataConnectionState=2/{print s; exit}')
		[ -z "$csig" ] && csig=$(echo "$celld" | grep -m1 "mSignalStrength=SignalStrength")
		crat=$(echo "$csig" | grep -oE 'primary=CellSignalStrength[A-Za-z]+' | head -1 | sed 's/.*Strength//')
		[ -z "$crat" ] && crat=Lte
		case "$crat" in Nr) label="5G" ;; Lte) label="4G" ;; Wcdma|Tdscdma) label="3G" ;; Gsm|Cdma) label="2G" ;; esac
		csub=$(echo "$csig" | grep -oE "m$crat=CellSignalStrength$crat[^,]*")
		cdbm=$(echo "$csub" | grep -oiE '(ss)?rsrp *= *-?[0-9]+' | grep -oE '\-?[0-9]+' | head -1)
		case "$cdbm" in -*) extra="$extra · ${cdbm} dBm" ;; esac
	fi
	[ -f "$MODPATH/active_profile" ] && extra="$extra · $(cat "$MODPATH/active_profile")"
	[ -f "$MODPATH/adv_buffers" ] && extra="$extra · +16M"
	# sed uses | as delimiter so the cc/qdisc slash is safe; keep no | in $desc
	local desc="TCP tuning · $label $icon · $CURRENT_ALGO/$CURRENT_QDISC$extra"
	sed -i -e "s|^description=.*|description=$desc|" "$MODPATH/module.prop"
}

kill_tcp_connections() {
	if [ -f "$MODPATH/kill_connections" ]; then
		log_print "Killing all TCP connections (IPv4 and IPv6) due to congestion change"
		
		# Kill all connections
		ss -K
	fi
}

set_max_initcwnd_initrwnd() {
	local active_iface="$1"
	if [ -f "$MODPATH/initcwnd_initrwnd" ]; then
		maxBufferSize=$(cat /proc/sys/net/ipv4/tcp_rmem | awk '{print $3}')
		maxBufferSize=${maxBufferSize:-16777216}
		mtu=$(ip link show "$active_iface" | awk '/mtu/ {print $NF}')
		mtu=${mtu:-1500}
		mtu=$((mtu - 40))
		maxInitrwndValue=$((maxBufferSize / mtu))
		if [ "$maxInitrwndValue" -gt 20 ]; then
			maxInitrwndValue=20
		fi
		local applied cmds4 cmds6
		applied=0; cmds4=""; cmds6=""

		# Build one batched script per address family instead of spawning a fresh
		# `su` for every route (the read-only `route show` runs directly since the
		# service is already root). This collapses ~14 /data/adb execs into 2,
		# which keeps OxygenOS's kernel anti-tamper from tripping the "malicious
		# app" popup when settings are (re)applied.
		# Android policy routing keeps the operative routes - including `default` -
		# in the per-interface table, while `main` only holds the on-link LAN
		# route. Writing initcwnd/initrwnd to `main` alone therefore never touched
		# internet traffic. Cover both tables, exactly like set_route_congctl.
		while IFS= read -r line; do
			[ -z "$line" ] && continue
			case "$line" in unreachable*|throw*|blackhole*|prohibit*) continue ;; esac
			cmds4="${cmds4}/system/bin/ip route change $line initcwnd 10 initrwnd $maxInitrwndValue 2>/dev/null
"
		done <<EOF
$(/system/bin/ip route show 2>/dev/null | grep "dev $active_iface")
EOF
		while IFS= read -r line; do
			[ -z "$line" ] && continue
			case "$line" in unreachable*|throw*|blackhole*|prohibit*) continue ;; esac
			cmds4="${cmds4}/system/bin/ip route change $line table $active_iface initcwnd 10 initrwnd $maxInitrwndValue 2>/dev/null
"
		done <<EOF
$(/system/bin/ip route show table "$active_iface" 2>/dev/null)
EOF
		[ -n "$cmds4" ] && run_as_su "$cmds4" && applied=1

		while IFS= read -r line; do
			[ -z "$line" ] && continue
			case "$line" in unreachable*|throw*|blackhole*|prohibit*) continue ;; esac
			cmds6="${cmds6}/system/bin/ip -6 route change $line initcwnd 10 initrwnd $maxInitrwndValue 2>/dev/null
"
		done <<EOF
$(/system/bin/ip -6 route show 2>/dev/null | grep "dev $active_iface")
EOF
		while IFS= read -r line; do
			[ -z "$line" ] && continue
			case "$line" in unreachable*|throw*|blackhole*|prohibit*) continue ;; esac
			cmds6="${cmds6}/system/bin/ip -6 route change $line table $active_iface initcwnd 10 initrwnd $maxInitrwndValue 2>/dev/null
"
		done <<EOF
$(/system/bin/ip -6 route show table "$active_iface" 2>/dev/null)
EOF
		[ -n "$cmds6" ] && run_as_su "$cmds6" && applied=1

		if [ "$applied" -eq 1 ]; then
			log_print "Setting initcwnd = 10; initrwnd = $maxInitrwndValue!"
		fi
	fi
}

get_active_root_qdisc() {
	local iface="$1"
	run_tc qdisc show dev "$iface" 2>/dev/null
}

set_qdisc() {
	local iface="$1"
	local qdisc="$2"
	local mode="$3"

	local qdisc_args="$qdisc"
	local handle_flag=""
	local cake_hint="" cake_bw="" cake_rtt="" chbw="" chrtt=""

	case "$qdisc" in
        fq)          		qdisc_args="fq pacing limit 2000 flow_limit 40 buckets 1024 initial_quantum 15000" ;;
        fq_codel)    		qdisc_args="fq_codel limit 1024 target 5ms interval 100ms ecn" ;;
        htb)         		handle_flag="handle 1:"; qdisc_args="htb default 1 r2q 10" ;;
        sfq)         		qdisc_args="sfq" ;;
        multiq)      		qdisc_args="multiq" ;;
        tbf)         		qdisc_args="tbf rate 1000mbit burst 100kb latency 50ms" ;;
        prio)        		handle_flag="handle 1:"; qdisc_args="prio bands 3" ;;
        pfifo)       		qdisc_args="pfifo limit 2000" ;;
        pfifo_head_drop) 	qdisc_args="pfifo_head_drop limit 2000" ;;
        bfifo)       		qdisc_args="bfifo limit 3145728" ;;
        pfifo_fast)  		qdisc_args="pfifo_fast" ;;
        cake)
            # "Smart cake": if a bufferbloat test left a measured rate/RTT for this
            # link, shape to it (engages the shaper + ack-filter) instead of running
            # cake unlimited. Hint file "cake_hint_<wlan|rmnet>" holds "<mbit> <ms>".
            cake_hint="$MODPATH/cake_hint_wlan"
            case "$iface" in *rmnet*|*ccmni*) cake_hint="$MODPATH/cake_hint_rmnet" ;; esac
            if [ -f "$cake_hint" ]; then
                read chbw chrtt _ < "$cake_hint"
                [ -n "$chbw" ] && [ "$chbw" -gt 0 ] 2>/dev/null && cake_bw="bandwidth ${chbw}mbit"
                [ -n "$chrtt" ] && [ "$chrtt" -gt 0 ] 2>/dev/null && cake_rtt="rtt ${chrtt}ms"
            fi
            qdisc_args="cake $cake_bw $cake_rtt besteffort triple-isolate wash ack-filter"
            ;;
        pie)         		qdisc_args="pie target 15ms tupdate 15ms alpha 2 beta 20 ecn" ;;
		fq_pie)      		qdisc_args="fq_pie limit 2000 target 15ms tupdate 15ms alpha 2 beta 20 ecn" ;;
		*) 					qdisc_args="$qdisc" ;;
    esac

	if [ -n "$handle_flag" ]; then
        run_tc qdisc replace dev "$iface" root $handle_flag $qdisc_args 2>/dev/null
    else
        run_tc qdisc replace dev "$iface" root $qdisc_args 2>/dev/null
    fi

	sleep 2
	# Match the qdisc name on a word boundary AND anchored to the root: a bare
	# `grep "$qdisc"` reports success for "fq" when the link actually runs
	# fq_codel (same trap for pfifo vs pfifo_fast), and an unanchored line match
	# is satisfied by a leaf — e.g. OxygenOS's htb root with an fq_codel child.
	local check_qdisc=$(get_active_root_qdisc "$iface" | grep -E "^qdisc ${qdisc} [0-9a-f]+: root")
	if [ -n "$check_qdisc" ]; then
		log_print "Applied qdisc: $qdisc ($iface)"
		sleep 0.1
		
		if [ "$qdisc" = "htb" ]; then
			run_tc class add dev "$iface" parent 1: classid 1:1 htb rate 1000mbit ceil 1000mbit 2>/dev/null
			run_tc qdisc add dev "$iface" parent 1:1 handle 10: fq_codel ecn 2>/dev/null

			log_print " [+] Attached low-latency fq_codel leaf to HTB root on $iface"
		elif [ "$qdisc" = "multiq" ]; then
			sleep 0.5
			local qdisc_show=$(get_active_root_qdisc "$iface" | grep multiq)
			local root_handle=$(echo "$qdisc_show" | awk '{print $3}')
			local total_bands=$(echo "$qdisc_show" | grep -o "bands [^ ]*" | awk '{print $2}' | cut -d'/' -f1)
			
			root_handle=${root_handle:-"1:"}
			total_bands=${total_bands:-4}
			
			log_print " [#] $qdisc_show"
			log_print " [~] Configuring $total_bands bands on parent $root_handle dynamically..."

			local i=1
			while [ "$i" -le "$total_bands" ]; do
				local hex_id=$(printf "%x" "$i")
				run_tc qdisc add dev "$iface" parent ${root_handle}${hex_id} handle $((i + 10)): fq_codel limit 1024 target 5ms interval 100ms ecn 2>/dev/null
				i=$((i + 1))
			done

			log_print " [+] Fully optimized multiq hardware lanes on $iface"
		elif [ "$qdisc" = "prio" ]; then
			local b=1
			while [ "$b" -le 3 ]; do
				run_tc qdisc add dev "$iface" parent 1:$b handle $((b + 20)): fq_codel limit 1024 target 5ms interval 100ms ecn 2>/dev/null
				b=$((b + 1))
			done
			log_print " [+] Attached low-latency fq_codel leaves to all prio bands on $iface"
		fi

		CURRENT_QDISC=$qdisc
		update_description "$mode"
	else
		log_print "Failed to apply qdisc: $qdisc ($iface)"
	fi
}

# Pin the congestion control onto the routes of one interface (RTAX_CC_ALGO,
# `ip route ... congctl`). Unlike the global sysctl, a pinned route keeps its
# CC even while another interface is the default route — so wlan and rmnet
# can run different algorithms simultaneously. Android policy routing keeps
# the operative routes in the per-interface table (`table wlan0`), so target
# that first and the main table as a fallback. Batched into one `su` exec per
# family (same OxygenOS anti-tamper rationale as the initcwnd block above).
set_route_congctl() {
	local iface="$1"
	local algo="$2"
	local cmds4 cmds6
	[ -z "$iface" ] && return
	cmds4=""; cmds6=""
	while IFS= read -r line; do
		[ -z "$line" ] && continue
		case "$line" in
		*"congctl $algo "*|*"congctl $algo") continue ;;   # already pinned
		unreachable*|throw*|blackhole*|prohibit*) continue ;;
		esac
		cmds4="${cmds4}/system/bin/ip route change $line table $iface congctl $algo 2>/dev/null
"
	done <<EOF
$(/system/bin/ip route show table "$iface" 2>/dev/null)
EOF
	while IFS= read -r line; do
		[ -z "$line" ] && continue
		case "$line" in
		*"congctl $algo "*|*"congctl $algo") continue ;;
		unreachable*|throw*|blackhole*|prohibit*) continue ;;
		esac
		cmds6="${cmds6}/system/bin/ip -6 route change $line table $iface congctl $algo 2>/dev/null
"
	done <<EOF
$(/system/bin/ip -6 route show table "$iface" 2>/dev/null)
EOF
	[ -n "$cmds4" ] && run_as_su "$cmds4"
	[ -n "$cmds6" ] && run_as_su "$cmds6"
	[ -n "$cmds4$cmds6" ] && log_print "Pinned congctl $algo on $iface routes"
}

set_congestion() {
	local algo="$1"
	local mode="$2"
	if echo "$congestion_algorithms" | grep -qw "$algo"; then
		echo "$algo" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null
		log_print "Applied congestion control: $algo ($mode)"
		kill_tcp_connections
		CURRENT_ALGO=$algo
		set_route_congctl "$(get_active_iface)" "$algo"
		update_description "$mode"
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
	iface=$(ip route get 192.0.2.1 2>/dev/null | grep -o "dev [^ ]*" | awk '{print $2}')
	echo "$iface"
}

# With a VPN up the default route points at tun0, but tuning tun0 is useless:
# the bottleneck is the physical link underneath, `ip route show table tun0` is
# empty so congctl pinning is a no-op, and get_wifi_freq finds no band. Resolve
# a tunnel to the physical interface that actually carries the traffic.
resolve_phys_iface() {
	local iface="$1" cand st
	case "$iface" in
		tun*|ppp*|ipsec*|wg*) ;;
		*) echo "$iface"; return ;;
	esac
	# Wi-Fi first: Android prefers it as the default transport whenever it is
	# connected, and the cellular interfaces stay registered (with default routes
	# in their tables) even while Wi-Fi carries the traffic. Skip the r_rmnet_*
	# reverse-tether devices. Note rmnet links report operstate "unknown", never
	# "up", so accept both.
	for cand in $(ls /sys/class/net 2>/dev/null | grep -E '^wlan') \
	            $(ls /sys/class/net 2>/dev/null | grep -E '^(rmnet_data|ccmni)'); do
		st=$(cat "/sys/class/net/$cand/operstate" 2>/dev/null)
		[ "$st" = "up" ] || [ "$st" = "unknown" ] || continue
		ip route show table "$cand" 2>/dev/null | grep -q '^default' || continue
		echo "$cand"
		return
	done
	echo "$iface"
}

get_wifi_freq() {
	local iface="$1"
	iw dev "$iface" link 2>/dev/null | grep "freq:" | awk '{print $2}'
}

extract_qdisc_from_path() {
    local filepath="$1"
    local algo="$2"
    local filename="${filepath##*/}" # Strips the directory path, leaves just the filename

    case "$filename" in
        rmnet_data_"${algo}"_*)
            echo "${filename#rmnet_data_${algo}_}"
            ;;
        wlan_"${algo}"_*)
            echo "${filename#wlan_${algo}_}"
            ;;
    esac
}

apply_tcp_buffers() {
	# Optional "Advanced TCP buffers" toggle (adv_buffers marker). Lets BBR/CUBIC
	# fill high-BDP Wi-Fi 6 / 5G links by RAISING the socket-buffer ceilings only.
	# It never lowers a value: on ROMs that already tune these high (e.g. OxygenOS
	# already ships 16 MiB core max, slow_start_after_idle=0, mtu_probing=1) it is
	# a no-op; the tcp_rmem/tcp_wmem min & default are always preserved so a well
	# tuned ROM is never degraded. Global sysctls; disabling reverts on reboot.
	[ -f "$MODPATH/adv_buffers" ] || return 0
	local target=16777216
	local changed=0

	# core ceilings: raise only
	for f in /proc/sys/net/core/rmem_max /proc/sys/net/core/wmem_max; do
		cur=$(cat "$f" 2>/dev/null)
		[ -n "$cur" ] && [ "$cur" -lt "$target" ] && echo "$target" > "$f" 2>/dev/null && changed=1
	done

	# tcp_rmem / tcp_wmem: keep "min default", raise only the max
	for f in /proc/sys/net/ipv4/tcp_rmem /proc/sys/net/ipv4/tcp_wmem; do
		set -- $(cat "$f" 2>/dev/null)
		[ -n "$3" ] && [ "$3" -lt "$target" ] && echo "$1 $2 $target" > "$f" 2>/dev/null && changed=1
	done

	# tolerate more packet reordering before cutting cwnd (helps on wide /
	# aggregated Wi-Fi where frames arrive out of order) — raise only, default 300
	cur=$(cat /proc/sys/net/ipv4/tcp_max_reordering 2>/dev/null)
	[ -n "$cur" ] && [ "$cur" -lt 1000 ] && echo 1000 > /proc/sys/net/ipv4/tcp_max_reordering 2>/dev/null && changed=1

	# strict improvements (idempotent): keep cwnd across idle, probe PMTU
	echo 0 > /proc/sys/net/ipv4/tcp_slow_start_after_idle 2>/dev/null
	echo 1 > /proc/sys/net/ipv4/tcp_mtu_probing 2>/dev/null
	# log only when something was actually raised — this also runs from the
	# 30/60s drift guard, which would otherwise spam the (200-line) log
	[ "$changed" -eq 1 ] && log_print "Advanced TCP buffers: raised socket-buffer ceilings to >=16MiB + tcp_max_reordering>=1000 (min/default preserved)"
	return 0
}

apply_wifi_settings() {
	local iface="$1"
	local applied=0
	freq=$(get_wifi_freq "$iface")
	log_print "Wi-Fi band detected: ${freq} MHz"
	if [ -n "$freq" ]; then
		if [ "$freq" -lt 3000 ]; then
			# 2.4 GHz
			set_tcp_pacing 150 200
		elif [ "$freq" -lt 6000 ]; then
			# 5 GHz or higher
			set_tcp_pacing 200 300
		else
			# 6 GHz or higher
			set_tcp_pacing 250 350
		fi
	fi

	for algo in $congestion_algorithms; do
		for filepath in "$MODPATH/wlan_${algo}_"*; do
			if [ -f "$filepath" ]; then
				set_congestion "$algo" "Wi-Fi"

				local qdisc=$(extract_qdisc_from_path "$filepath" "$algo")
				set_qdisc "$iface" "$qdisc" "Wi-Fi"

				set_max_initcwnd_initrwnd "$iface"
				echo 8000 > /proc/sys/net/ipv4/tcp_rto_max 2>/dev/null
				applied=1
				break 2
			fi
		done
	done
	[ "$applied" -eq 0 ] && set_congestion cubic "Wi-Fi" && set_max_initcwnd_initrwnd "$iface"
	apply_tcp_buffers
	return $applied
}

apply_cellular_settings() {
	local iface="$1"
	local applied=0
	
	set_tcp_pacing 120 200
	
	for algo in $congestion_algorithms; do
		for filepath in "$MODPATH/rmnet_data_${algo}_"*; do
			if [ -f "$filepath" ]; then
				set_congestion "$algo" "Cellular"

				local qdisc=$(extract_qdisc_from_path "$filepath" "$algo")
				set_qdisc "$iface" "$qdisc" "Cellular"

				set_max_initcwnd_initrwnd "$iface"
				echo 15000 > /proc/sys/net/ipv4/tcp_rto_max 2>/dev/null
				applied=1
				break 2
			fi
		done
	done
	[ "$applied" -eq 0 ] && set_congestion cubic "Cellular" && set_max_initcwnd_initrwnd "$iface"
	apply_tcp_buffers
	return $applied
}

# Drift guard. OxygenOS's network stack transiently takes the interface back
# (observed on OP15 ~1 min after boot: its own `htb default 1` root, stock
# sysctl profile incl. 8.8M buffer maxes, rebuilt route tables, cc reset to the
# kernel default). If such a window ends in the drifted state, nothing else in
# the module converges back — so guard ALL of it, not just the qdisc: root
# qdisc, global cc, per-route congctl, initcwnd, buffer ceilings. Re-asserts
# are quiet (no ss -K — killing every TCP connection on a periodic guard would
# be destructive) and each drift is logged with what drifted, which doubles as
# forensics on when/what OxygenOS touches.
run_qdisc_watchdog() {
    local watch_iface="$1"
    local mode="$2"
	local sleep_interval="${3:-15}"
	local target_qdisc=""
	local target_algo=""
	local prefix="wlan"

	[ "$mode" = "Cellular" ] && prefix="rmnet_data"
	for algo in $congestion_algorithms; do
		for filepath in "$MODPATH/${prefix}_${algo}_"*; do
			if [ -f "$filepath" ]; then
				target_algo="$algo"
				target_qdisc=$(extract_qdisc_from_path "$filepath" "$algo")
				break 2
			fi
		done
	done

	# No marker file => apply_{wifi,cellular}_settings applied no qdisc at all
	# (it only falls back to cubic). Forcing htb/multiq here would install a
	# qdisc the user never chose, so guard nothing instead.
	if [ -z "$target_qdisc" ]; then
		log_print "[WATCHDOG] No qdisc marker for $mode - nothing to guard on $watch_iface."
		rm -f "$MODPATH/.qdisc_guard"
		return 0
	fi

    log_print "[WATCHDOG] Guarding $watch_iface: qdisc=$target_qdisc cc=$target_algo"

    while true; do
        local link_state=""
        if [ -f "/sys/class/net/$watch_iface/operstate" ]; then
            link_state=$(cat "/sys/class/net/$watch_iface/operstate")
        fi

        if [ "$link_state" = "down" ] || [ -z "$link_state" ]; then
            log_print "[WATCHDOG] Interface $watch_iface is inactive (state: $link_state). Stopping monitor."
            rm -f "$MODPATH/.qdisc_guard"
            break
        fi

        # heartbeat for the WebUI "Guarding" indicator (freshness = still alive);
        # write-then-rename so a concurrent reader never sees a truncated file
        echo "$watch_iface $target_qdisc" > "$MODPATH/.qdisc_guard.tmp" && \
            mv -f "$MODPATH/.qdisc_guard.tmp" "$MODPATH/.qdisc_guard"

        local drift=""

        # 1. root qdisc — anchored to the root line; an fq_codel LEAF under a
        #    foreign htb root must not satisfy the check
        local current_status=$(get_active_root_qdisc "$watch_iface")
        echo "$current_status" | grep -qE "^qdisc ${target_qdisc} [0-9a-f]+: root" || drift="qdisc"

        # 2. global congestion control
        local cur_cc=$(cat /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null)
        [ "$cur_cc" = "$target_algo" ] || drift="$drift cc($cur_cc)"

        # 3. route pinning — only judged when a default route exists (a missing
        #    default is a transient netd rebuild; re-pinning mid-rebuild thrashes)
        local def_route=$(ip route show table "$watch_iface" 2>/dev/null | grep '^default')
        if [ -n "$def_route" ]; then
            case "$def_route" in
                *"congctl $target_algo "*|*"congctl $target_algo") ;;
                *) drift="$drift route" ;;
            esac
            if [ -f "$MODPATH/initcwnd_initrwnd" ]; then
                case "$def_route" in
                    *"initcwnd "*) ;;
                    *) drift="$drift initcwnd" ;;
                esac
            fi
        fi

        # 4. buffer ceilings (only meaningful when the toggle is on)
        if [ -f "$MODPATH/adv_buffers" ]; then
            set -- $(cat /proc/sys/net/ipv4/tcp_rmem 2>/dev/null)
            [ -n "$3" ] && [ "$3" -lt 16777216 ] && drift="$drift buffers"
        fi

        if [ -n "$drift" ]; then
            log_print "[!] Drift on $watch_iface: $drift"
            case "$drift" in *"qdisc"*)
                log_print "[!] Root was: $(echo "$current_status" | head -n 1)"
                set_qdisc "$watch_iface" "$target_qdisc" "$mode"
            ;; esac
            # quiet cc + route re-assert: no ss -K, no description rewrite
            echo "$target_algo" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null
            set_route_congctl "$watch_iface" "$target_algo"
            set_max_initcwnd_initrwnd "$watch_iface"
            apply_tcp_buffers
            log_print "[#] Re-asserted qdisc=$target_qdisc cc=$target_algo on $watch_iface"
        fi
        sleep "$sleep_interval"
    done
}

set_tcp_mem() {
	local mem_total_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
	# pages = KB*1024/4096 == KB/4. Divide first: KB*1024 overflows 32-bit shell
	# arithmetic on high-RAM devices (e.g. 16 GB -> ~15.8e9) and wraps negative.
	local mem_total_pages=$((mem_total_kb / 4))

	# cap tcp_mem at ~6-8% of total RAM for "pressure", ~10% for "max"
	local low=$((mem_total_pages * 4 / 100))
	local pressure=$((mem_total_pages * 6 / 100))
	local high=$((mem_total_pages * 10 / 100))

	echo "$low $pressure $high" > /proc/sys/net/ipv4/tcp_mem 2>/dev/null
	log_print "tcp_mem set to: $low $pressure $high pages (mem_total=${mem_total_kb}KB)"
}

# Start Run Code

# IPv4 TCP optimizations
echo 1 > /proc/sys/net/ipv4/tcp_ecn 2>/dev/null
echo "fq_codel" > /proc/sys/net/core/default_qdisc 2>/dev/null
echo 120 > /proc/sys/net/ipv4/tcp_pacing_ca_ratio 2>/dev/null
echo 180 > /proc/sys/net/ipv4/tcp_pacing_ss_ratio 2>/dev/null
echo 1 > /proc/sys/net/ipv4/tcp_window_scaling 2>/dev/null

# Socket buffers: RAISE ONLY, same rule as apply_tcp_buffers(). The old fixed
# "4096 2097152 16777216" replaced the ROM's tuned min & default (OxygenOS ships
# 524288 1048576 16777216) with a 2 MiB default per socket, and pre-empted the
# "Advanced TCP buffers" toggle by putting the ceilings at 16 MiB unconditionally.
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
# PMTU probing: OxygenOS already ships 1; writing 0 downgraded the ROM every boot.
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
set_tcp_mem
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

last_mode=""
change_time=0
vowifi_pending=0
vowifi_start_time=0
WATCHDOG_PID=""

resetprop -w sys.boot_completed 0

until [ -d "/sdcard/Android/data" ]; do sleep 1; done
sleep 20
current_time=0

while true; do
	iface=$(get_active_iface)
	iface=$(resolve_phys_iface "$iface")

	new_mode="none"
	case "$iface" in
		wlan*) new_mode="Wi-Fi" ;;
		*rmnet*|*ccmni*) new_mode="Cellular" ;;
		# unresolved tunnel (no physical link found): keep the old Wi-Fi default
		tun*|ppp*|ipsec*|wg*) new_mode="Wi-Fi" ;;
		*) new_mode="none" ;;
	esac

	if [ "$new_mode" != "$last_mode" ] || [ -f "$MODPATH/force_apply" ]; then
		if [ "$((current_time - change_time))" -ge "$DEBOUNCE_TIME" ] || [ "$last_mode" = "none" ]; then
			
			if [ -n "$WATCHDOG_PID" ]; then
				kill "$WATCHDOG_PID" 2>/dev/null
				WATCHDOG_PID=""
			fi
			
			if [ "$new_mode" = "Wi-Fi" ]; then
				if [ "$new_mode" = "$last_mode" ]; then
					# force_apply on an already-connected Wi-Fi: apply now (skip VoWiFi wait)
					vowifi_pending=0
					apply_wifi_settings "$iface"
					run_qdisc_watchdog "$iface" "Wi-Fi" "30" &
					WATCHDOG_PID=$!
				else
					# fresh Wi-Fi connection: wait for VoWiFi to settle before applying
					vowifi_pending=1
					vowifi_start_time="$current_time"
				fi
			elif [ "$new_mode" = "Cellular" ]; then
				vowifi_pending=0
				apply_cellular_settings "$iface"

				run_qdisc_watchdog "$iface" "Cellular" "60" &
				WATCHDOG_PID=$!
			elif [ "$new_mode" = "none" ]; then
                vowifi_pending=0
                log_print "[INFO] Interface completely disconnected (Airplane Mode / Internet Off)."
            fi
			last_mode="$new_mode"
			change_time="$current_time"
			rm -f "$MODPATH/force_apply"
		else
            log_print "[DEBUG] Network change throttled by DEBOUNCE_TIME. Retrying shortly..."
        fi
	fi
	
	# === Wi-Fi Pending Logic ===
	if [ "$new_mode" = "Wi-Fi" ] && [ "$vowifi_pending" -eq 1 ]; then
		vowifi=$(get_wifi_calling_state)
		vowifi=${vowifi:-1}
		if [ "$((current_time - vowifi_start_time))" -ge "$VOWIFI_CONNECT_TIME" ]; then
			log_print "[INFO] VoWiFi timeout reached. Applying Wi-Fi settings..."
			vowifi_pending=0
			apply_wifi_settings "$iface"

			run_qdisc_watchdog "$iface" "Wi-Fi" "30" &
			WATCHDOG_PID=$!
		elif [ "$vowifi" -eq 0 ]; then
			log_print "[INFO] VoWiFi activated. Applying Wi-Fi settings..."
			vowifi_pending=0
			apply_wifi_settings "$iface"

			run_qdisc_watchdog "$iface" "Wi-Fi" "30" &
			WATCHDOG_PID=$!
		fi
	fi

	sleep 5
	current_time=$((current_time + 5))
done
