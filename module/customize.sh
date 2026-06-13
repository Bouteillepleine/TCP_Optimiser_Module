#!/system/bin/sh

ui_print " [+] Starting module customization..."

# Detect congestion algorithm
ui_print " [+] Checking TCP congestion algorithm..."

AVAILABLE_CONG="$(cat /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null)"

if echo "$AVAILABLE_CONG" | grep -qw bbrv3; then
	CONG="bbrv3"
	ui_print " [+] Found BBRv3!"
elif echo "$AVAILABLE_CONG" | grep -qw bbr; then
	CONG="bbr"
	ui_print " [+] Found BBR!"
else
	CONG="cubic"
	ui_print " [+] BBR/BBRv3 not found. Going with Cubic!"
fi

MODULE_NAME="$(basename "$MODPATH")"
MODULE_PATH="/data/adb/modules/$MODULE_NAME"

DEFAULT_WIFI_QDISC="fq_codel"
DEFAULT_CELLULAR_QDISC="fq_codel"

# Check both live and update folders for a specific marker pattern.
check_marker_anywhere() {
	local pattern="$1"

	if find "$MODPATH" -maxdepth 1 -type f -name "$pattern" -print -quit 2>/dev/null | grep -q .; then
		return 0
	fi

	if find "$MODULE_PATH" -maxdepth 1 -type f -name "$pattern" -print -quit 2>/dev/null | grep -q .; then
		return 0
	fi

	return 1
}

# Copy one existing marker from live module path into update/install path.
copy_marker_from_live_if_needed() {
	local pattern="$1"
	local source_file=""
	local file_name=""

	if [ "$KSU" = true ]; then
		source_file="$(find "$MODULE_PATH" -maxdepth 1 -type f -name "$pattern" -print -quit 2>/dev/null)"

		if [ -n "$source_file" ]; then
			cp "$source_file" "$MODPATH/"
			file_name="$(basename "$source_file")"
			ui_print " [+] Copied from $MODULE_PATH to $MODPATH: $file_name"
			return 0
		fi
	fi

	return 1
}

create_marker_if_needed() {
	local pattern="$1"
	local target="$2"

	if check_marker_anywhere "$pattern"; then
		if copy_marker_from_live_if_needed "$pattern"; then
			return
		fi

		ui_print " [-] Skipping $target: matching marker already exists."
		return
	fi

	if [ ! -f "$target" ]; then
		touch "$target"
		chmod 644 "$target"
		ui_print " [+] Created: $target"
	else
		ui_print " [-] Skipped: $target already exists."
	fi
}

# Algorithm marker helpers.
# Important:
# Do not use "wlan_*" for algorithm checks because it would also match "wlan_qdisc_*".
create_algo_marker_if_needed() {
	local prefix="$1"
	local algo="$2"
	local pattern=""
	local target=""

	case "$prefix" in
		wlan)
			pattern="wlan_bbrv3 wlan_bbr wlan_cubic wlan_reno wlan_westwood wlan_htcp"
			;;

		rmnet_data)
			pattern="rmnet_data_bbrv3 rmnet_data_bbr rmnet_data_cubic rmnet_data_reno rmnet_data_westwood rmnet_data_htcp"
			;;

		*)
			ui_print " [!] Unknown algorithm prefix: $prefix"
			return
			;;
	esac

	# Check each known algorithm marker independently.
	for marker in $pattern; do
		if check_marker_anywhere "$marker"; then
			copy_marker_from_live_if_needed "$marker" >/dev/null 2>&1
			ui_print " [-] Skipping ${prefix}_${algo}: existing algorithm marker found."
			return
		fi
	done

	target="$MODPATH/${prefix}_${algo}"

	touch "$target"
	chmod 644 "$target"
	ui_print " [+] Created: $target"
}

create_qdisc_marker_if_needed() {
	local prefix="$1"
	local qdisc="$2"
	local pattern="${prefix}_qdisc_*"
	local target="$MODPATH/${prefix}_qdisc_${qdisc}"

	create_marker_if_needed "$pattern" "$target"
}

# Create wlan_* based on best available algorithm:
# bbrv3 -> bbr -> cubic
create_algo_marker_if_needed "wlan" "$CONG"

# Cellular stays on Cubic by default for safer behavior on mobile networks.
create_algo_marker_if_needed "rmnet_data" "cubic"

# Create qdisc defaults.
# fq_codel is the safe default, including for BBR/BBRv3, due to Wi-Fi Calling stability.
create_qdisc_marker_if_needed "wlan" "$DEFAULT_WIFI_QDISC"
create_qdisc_marker_if_needed "rmnet_data" "$DEFAULT_CELLULAR_QDISC"

# Preserve kill_connections marker if it exists.
if check_marker_anywhere "kill_connections"; then
	if [ "$KSU" = true ]; then
		source_file="$(find "$MODULE_PATH" -maxdepth 1 -type f -name "kill_connections" -print -quit 2>/dev/null)"

		if [ -n "$source_file" ]; then
			cp "$source_file" "$MODPATH/"
			chmod 644 "$MODPATH/kill_connections"
			ui_print " [+] Copied from $MODULE_PATH to $MODPATH: kill_connections"
		fi
	else
		ui_print " [-] Skipping $MODPATH/kill_connections: file already exists."
	fi
fi

# Preserve initcwnd_initrwnd marker if it exists.
if check_marker_anywhere "initcwnd_initrwnd"; then
	if [ "$KSU" = true ]; then
		source_file="$(find "$MODULE_PATH" -maxdepth 1 -type f -name "initcwnd_initrwnd" -print -quit 2>/dev/null)"

		if [ -n "$source_file" ]; then
			cp "$source_file" "$MODPATH/"
			chmod 644 "$MODPATH/initcwnd_initrwnd"
			ui_print " [+] Copied from $MODULE_PATH to $MODPATH: initcwnd_initrwnd"
		fi
	else
		ui_print " [-] Skipping $MODPATH/initcwnd_initrwnd: file already exists."
	fi
fi

# Ensure service log exists for WebUI logs page.
LOG_FILE="$MODPATH/service.log"

if [ ! -f "$LOG_FILE" ]; then
	touch "$LOG_FILE"
	chmod 644 "$LOG_FILE"
	ui_print " [+] Created: $LOG_FILE"
fi

ui_print " [+] Module customization complete."
