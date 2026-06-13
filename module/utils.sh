#!/system/bin/sh

MODPATH="${0%/*}"
LOGFILE="$MODPATH/service.log"
FLAGFILE="/dev/.tcp_module_log_cleared"
MAX_LOG_LINES=200
DUMPSYS_TMP_FILE="$MODPATH/dumpsys.tmp"

ensure_log_file() {
	mkdir -p "$MODPATH" >/dev/null 2>&1
	touch "$LOGFILE" >/dev/null 2>&1
	chmod 644 "$LOGFILE" >/dev/null 2>&1
}

rotate_log_if_needed() {
	local line_count

	ensure_log_file

	line_count="$(wc -l < "$LOGFILE" 2>/dev/null)"
	line_count="${line_count:-0}"

	if [ "$line_count" -gt "$MAX_LOG_LINES" ]; then
		tail -n "$MAX_LOG_LINES" "$LOGFILE" > "${LOGFILE}.tmp" 2>/dev/null

		if [ -s "${LOGFILE}.tmp" ]; then
			mv "${LOGFILE}.tmp" "$LOGFILE" >/dev/null 2>&1
			chmod 644 "$LOGFILE" >/dev/null 2>&1
		else
			rm -f "${LOGFILE}.tmp" >/dev/null 2>&1
		fi
	fi
}

# Clear log on first run after boot, then recreate it immediately.
if [ ! -f "$FLAGFILE" ]; then
	rm -f "$LOGFILE" >/dev/null 2>&1
	touch "$FLAGFILE" >/dev/null 2>&1
	ensure_log_file
fi

ensure_log_file

log_print() {
	local message="$1"
	local timestamp

	ensure_log_file

	timestamp="$(date +'%Y-%m-%d %H:%M:%S')"
	echo "$timestamp - $message" >> "$LOGFILE"

	rotate_log_if_needed
}

run_as_su() {
	local cmd="$*"

	su -c "$cmd" >/dev/null 2>&1
	return $?
}

get_wifi_calling_state() {
	rm -f "$DUMPSYS_TMP_FILE" >/dev/null 2>&1

	dumpsys activity service SystemUIService > "$DUMPSYS_TMP_FILE" 2>/dev/null

	grep -qEm 1 "slot='vowifi'.*visible user=.*" "$DUMPSYS_TMP_FILE"
	local status=$?

	rm -f "$DUMPSYS_TMP_FILE" >/dev/null 2>&1

	# Echo result:
	# 0 = VoWiFi active
	# 1 = VoWiFi inactive / not detected
	echo "$status"
}
