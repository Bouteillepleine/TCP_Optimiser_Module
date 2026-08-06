#!/system/bin/sh

MODPATH="${0%/*}"
LOGFILE="$MODPATH/service.log"
FLAGFILE="/dev/.tcp_module_log_cleared"
MAX_LOG_LINES=200
DUMPSYS_TMP_FILE="$MODPATH/dumpsys.tmp"

# Clear log on first run after boot
if [ ! -f "$FLAGFILE" ]; then
    rm -f "$LOGFILE" >/dev/null 2>&1
    touch "$FLAGFILE" >/dev/null 2>&1
fi

log_print() {
	message="$1"

	timestamp=$(date +'%Y-%m-%d %H:%M:%S')
	echo "$timestamp - $message" >> "$LOGFILE"

	line_count=$(wc -l < "$LOGFILE" 2>/dev/null)
	if [ "$line_count" -gt "$MAX_LOG_LINES" ]; then
		tail -n "$((MAX_LOG_LINES / 2))" "$LOGFILE" > "${LOGFILE}.tmp"
		mv "${LOGFILE}.tmp" "$LOGFILE"
	fi
}

run_as_su() {
	# already root; run directly instead of re-spawning su
	eval "$*"
}

run_tc() {
	"$MODPATH/bin/tc" "$@"
	return $?
}

get_wifi_calling_state() {
	rm -f "$DUMPSYS_TMP_FILE"
	dumpsys activity service SystemUIService > "$DUMPSYS_TMP_FILE" 2>/dev/null
	# OxygenOS never prints the AOSP `slot='vowifi' ... visible user=` string, so
	# the old pattern never matched and every fresh Wi-Fi join sat out the full
	# VOWIFI_CONNECT_TIME timeout. Mirror the OxygenOS status-bar icon instead -
	# `NN:(vowifi) holder=StatusBarIconHolder(... visible=true)` / IMS
	# `vowifiState=true` - the same rule the WebUI uses (common.js
	# get_wifi_calling_state). The AOSP pattern is kept as a fallback for
	# non-OPlus ROMs.
	grep -qEm 1 "\(vowifi\).*visible=true|vowifiState=true|slot='vowifi'.*visible user=" "$DUMPSYS_TMP_FILE"
	local status=$?
	rm -f "$DUMPSYS_TMP_FILE"
	# echo's result: 0 = true (VoWiFi active), 1 = false
	echo $status
}