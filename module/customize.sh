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

MODULE_NAME=$(basename "$MODPATH")
MODULE_PATH="/data/adb/modules/$MODULE_NAME"

# Check both live and update folders
check_exists_anywhere() {
    local prefix="$1"

    # Check in current path
    if ls "$MODPATH"/${prefix}_* >/dev/null 2>&1; then
        return 0
    fi

    # Check in Module main path
    if ls "$MODULE_PATH"/${prefix}_* >/dev/null 2>&1; then
        return 0
    fi

    return 1
}

create_file_if_needed() {
    local prefix="$1"
    local suffix="$2"
    local target="$MODPATH/${prefix}_${suffix}"

    if check_exists_anywhere "$prefix"; then
        # If file exists and KSU is true, copy any file from MODULE_PATH with the same prefix
        if [ "$KSU" = true ]; then
            # Find any file starting with ${prefix}_ in MODULE_PATH and copy it to MODPATH
            source_file=$(find "$MODULE_PATH" -name "${prefix}_*" -print -quit 2>/dev/null)
            if [ -n "$source_file" ]; then
                cp "$source_file" "$MODPATH/"

                file_name=$(basename "$source_file")
                ui_print " [+] Copied from $MODULE_PATH to $MODPATH: $file_name"
            fi
        else
            ui_print " [-] Skipping $target: file already exists."
        fi
        return
    fi

    if [ ! -f "$target" ]; then
        touch "$target"
        ui_print " [+] Created: $target"
    else
        ui_print " [-] Skipped: $target already exists"
    fi
}

# Create wlan_* based on best available algorithm:
# bbrv3 -> bbr -> cubic
create_file_if_needed "wlan" "$CONG"

# Always create rmnet_data_cubic unless another exists
# Cellular stays on Cubic by default for safer behavior on mobile networks.
create_file_if_needed "rmnet_data" "cubic"

if check_exists_anywhere "kill"; then
    # If file exists and KSU is true, copy kill_connections from MODULE_PATH
    if [ "$KSU" = true ]; then
        source_file=$(find "$MODULE_PATH" -name "kill_connections" -print -quit 2>/dev/null)
        if [ -n "$source_file" ]; then
            cp "$source_file" "$MODPATH/"
            ui_print " [+] Copied from $MODULE_PATH to $MODPATH: kill_connections"
        fi
    else
        ui_print " [-] Skipping $MODPATH/kill_connections: file already exists."
    fi
fi

if check_exists_anywhere "initcwnd"; then
    # If file exists and KSU is true, copy initcwnd_initrwnd from MODULE_PATH
    if [ "$KSU" = true ]; then
        source_file=$(find "$MODULE_PATH" -name "initcwnd_initrwnd" -print -quit 2>/dev/null)
        if [ -n "$source_file" ]; then
            cp "$source_file" "$MODPATH/"
            ui_print " [+] Copied from $MODULE_PATH to $MODPATH: initcwnd_initrwnd"
        fi
    else
        ui_print " [-] Skipping $MODPATH/initcwnd_initrwnd: file already exists."
    fi
fi
