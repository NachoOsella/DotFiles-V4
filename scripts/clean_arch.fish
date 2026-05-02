#!/usr/bin/env fish

# ============================================================================
#  CLEAN ARCH - Deep System Cleanup for Arch Linux
# ============================================================================

set -g JOURNAL_RETENTION "7d"
set -g TEMP_FILE_AGE 7
set -g PACMAN_VERSIONS_KEEP 1
set -g ZED_NODE_VERSIONS_KEEP 1
set -g DOCKER_PRUNE_ALL 0
set -g PROFILE "balanced"

# Colors
set -g R (set_color normal)
set -g B (set_color --bold)
set -g D (set_color --dim)
set -g GREEN (set_color green)
set -g YELLOW (set_color yellow)
set -g RED (set_color red)
set -g CYAN (set_color cyan)
set -g MAGENTA (set_color magenta)
set -g BLUE (set_color blue)
set -g WHITE (set_color white)

# State
set -g DRY_RUN 0
set -g FORCE_YES 0
set -g NO_SPINNER 0
set -g NO_NOTIFY 0
set -g CURRENT_TASK ""
set -g CURRENT_TASK_PREFIX ""
set -g TASK_INDEX 0
set -g TASK_TOTAL 16
set -g SPINNER_PID 0
set -g SUDO_KEEPALIVE_PID 0
set -g LOCK_DIR "/tmp/clean_arch.lock"
set -g LOCK_HELD 0
set -g REPORT_JSON_PATH ""
set -g MAX_DELETE_GB 0
set -g MAX_DELETE_BYTES 0
set -g STOP_FOR_BUDGET 0

# Reporting state
set -g TASK_NAMES
set -g TASK_STATUSES
set -g TASK_DURATIONS_MS
set -g TASK_NOTES
set -g TASK_FREED_BYTES

set -g TOTAL_FREED_BYTES 0
set -g START_FREE_KB 0
set -g END_FREE_KB 0

# Task toggles
set -g do_orphans 1
set -g do_caches 1
set -g do_docker 1
set -g do_logs 1
set -g do_temps 1
set -g do_trash 1
set -g do_extras 1

set -g INCLUDE_TASKS
set -g EXCLUDE_TASKS

function clear_line
    printf "\r\033[K"
end

function term_cols
    if type -q tput
        set -l c (tput cols 2>/dev/null)
        if test -n "$c"
            echo $c
            return
        end
    end
    echo 80
end

function ui_width
    set -l cols (term_cols)
    # Keep extra right margin. Some terminals/recorders clip the last cell when
    # ANSI resets sit near the edge, so the UI intentionally avoids full width.
    set -l w (math "$cols - 8")
    if test $w -gt 88
        set w 88
    end
    if test $w -lt 50
        set w 50
    end
    echo $w
end

function pad_plain
    set -l text "$argv[1]"
    set -l width "$argv[2]"
    set -l len (string length -- "$text")
    if test $len -gt $width
        if test $width -gt 1
            set text (string sub -l (math "$width - 1") -- "$text")"…"
        else
            set text ""
        end
        set len (string length -- "$text")
    end
    set -l pad (math "$width - $len")
    if test $pad -lt 0
        set pad 0
    end
    printf "%s%s" "$text" (string repeat -n $pad " ")
end

function center_plain
    set -l text "$argv[1]"
    set -l width "$argv[2]"
    set -l len (string length -- "$text")
    set -l total (math "$width - $len")
    if test $total -lt 0
        set total 0
    end
    set -l left (math "floor($total / 2)")
    set -l right (math "$total - $left")
    printf "%s%s%s" (string repeat -n $left " ") "$text" (string repeat -n $right " ")
end

function progress_bar
    set -l current "$argv[1]"
    set -l total "$argv[2]"
    set -l width "$argv[3]"
    if test -z "$total"; or test $total -le 0
        set total 1
    end
    set -l filled (math "floor(($current * $width) / $total)")
    if test $filled -gt $width
        set filled $width
    end
    set -l empty (math "$width - $filled")
    printf "%s%s" (string repeat -n $filled "━") (string repeat -n $empty "·")
end

function ui_rule
    set -l w (ui_width)
    printf "  %s%s%s\n" $D (string repeat -n $w "─") $R
end

function ui_banner
    set -l w (ui_width)
    set -l inner (math "$w - 2")
    set -l title (center_plain "CLEAN ARCH" $inner)
    set -l subtitle (center_plain "safe deep cleanup for Arch Linux" $inner)
    echo
    printf "  %s╭%s╮%s\n" $D (string repeat -n $inner "─") $R
    printf "  %s│%s%s%s│%s\n" $D $B$CYAN "$title" $R$D $R
    printf "  %s│%s%s%s│%s\n" $D $D "$subtitle" $R$D $R
    printf "  %s╰%s╯%s\n" $D (string repeat -n $inner "─") $R
end

function ui_settings_panel
    set -l w (ui_width)
    set -l inner (math "$w - 2")
    set -l mode "LIVE"
    if test $DRY_RUN -eq 1
        set mode "DRY RUN"
    end
    set -l docker "safe"
    if test $DOCKER_PRUNE_ALL -eq 1
        set docker "all unused"
    end
    set -l budget "none"
    if test $MAX_DELETE_BYTES -gt 0
        set budget (format_bytes $MAX_DELETE_BYTES)
    end
    set -l report "disabled"
    if test -n "$REPORT_JSON_PATH"
        set report "$REPORT_JSON_PATH"
    end
    printf "  %s╭─%s%s╮%s\n" $D " Run plan " (string repeat -n (math "$inner - 10") "─") $R
    printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "Mode: $mode" (math "$inner - 1")) $D $R
    printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "Profile: $PROFILE   Journal: $JOURNAL_RETENTION   Temp age: $TEMP_FILE_AGE days" (math "$inner - 1")) $D $R
    printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "Pacman keep: $PACMAN_VERSIONS_KEEP   Zed node keep: $ZED_NODE_VERSIONS_KEEP   Docker: $docker" (math "$inner - 1")) $D $R
    printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "Budget: $budget   Report: $report" (math "$inner - 1")) $D $R
    printf "  %s╰%s╯%s\n" $D (string repeat -n $inner "─") $R
end

function ui_safety_panel
    set -l w (ui_width)
    set -l inner (math "$w - 2")
    printf "  %s╭─%s%s╮%s\n" $D " Safety boundaries " (string repeat -n (math "$inner - 19") "─") $R
    printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "Deletes cache, package-manager artifacts, old temp files and logs." (math "$inner - 1")) $D $R
    printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "Keeps logins, cookies, app profiles, IndexedDB, configs, Steam games and compatdata." (math "$inner - 1")) $D $R
    printf "  %s╰%s╯%s\n" $D (string repeat -n $inner "─") $R
end

function fmt_duration_ms
    set -l ms "$argv[1]"
    if test "$ms" -ge 1000
        printf "%.1fs" (math "$ms / 1000")
    else
        printf "%sms" "$ms"
    end
end

function kill_spinner
    if test $SPINNER_PID -ne 0
        kill $SPINNER_PID 2>/dev/null
        wait $SPINNER_PID 2>/dev/null
        set -g SPINNER_PID 0
    end
end

function cleanup_resources
    kill_spinner
    if test $SUDO_KEEPALIVE_PID -ne 0
        kill $SUDO_KEEPALIVE_PID 2>/dev/null
        wait $SUDO_KEEPALIVE_PID 2>/dev/null
        set -g SUDO_KEEPALIVE_PID 0
    end
    if test $LOCK_HELD -eq 1
        command rm -rf "$LOCK_DIR" 2>/dev/null
        set -g LOCK_HELD 0
    end
end

function cleanup_on_signal --on-signal INT --on-signal TERM
    cleanup_resources
    clear_line
    printf "\n  Interrupted.\n\n"
    exit 130
end

function acquire_lock
    if command mkdir "$LOCK_DIR" 2>/dev/null
        set -g LOCK_HELD 1
        echo $fish_pid >"$LOCK_DIR/pid" 2>/dev/null
        return 0
    end
    set -l holder "unknown"
    if test -f "$LOCK_DIR/pid"
        set holder (string trim (cat "$LOCK_DIR/pid" 2>/dev/null))
        if string match -qr '^[0-9]+$' -- "$holder"
            if not kill -0 $holder 2>/dev/null
                command rm -rf "$LOCK_DIR" 2>/dev/null
                if command mkdir "$LOCK_DIR" 2>/dev/null
                    set -g LOCK_HELD 1
                    echo $fish_pid >"$LOCK_DIR/pid" 2>/dev/null
                    return 0
                end
            end
        end
    end
    printf "  $RED✗$R Another clean_arch run appears active (pid: %s).\n\n" $holder
    return 1
end

function start_task
    set -g CURRENT_TASK $argv[1]
    set -l bar (progress_bar $TASK_INDEX $TASK_TOTAL 18)
    set -g CURRENT_TASK_PREFIX (printf "[%02d/%02d]" $TASK_INDEX $TASK_TOTAL)
    set -l label "$CURRENT_TASK_PREFIX $bar  $CURRENT_TASK"
    if test $DRY_RUN -eq 1
        printf "  $MAGENTA◇$R %s $D(dry-run)$R\n" "$label"
        return
    end
    if test $NO_SPINNER -eq 1
        printf "  $CYAN▸$R %s\n" "$label"
        return
    end
    if not isatty stdout
        printf "  $CYAN▸$R %s\n" "$label"
        return
    end
    set -l escaped_task (string escape -- "$label")
    fish -c "
        set FRAMES '⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏'
        set msg $escaped_task
        while true
            for frame in \$FRAMES
                printf '\r  \033[36m%s\033[0m %s' \$frame \$msg
                sleep 0.08
            end
        end
    " &
    set -g SPINNER_PID $last_pid
end

function end_task_ok
    set -l meta "$argv[1]"
    kill_spinner
    clear_line
    if test -n "$meta"
        printf "  %sOK%s %s %s  %s%s%s\n" $GREEN $R "$CURRENT_TASK_PREFIX" "$CURRENT_TASK" $D "$meta" $R
    else
        printf "  %sOK%s %s %s\n" $GREEN $R "$CURRENT_TASK_PREFIX" "$CURRENT_TASK"
    end
end

function end_task_skip
    set -l meta "$argv[1]"
    kill_spinner
    clear_line
    if test -n "$meta"
        printf "  $D-- %s %s  %s$R\n" "$CURRENT_TASK_PREFIX" "$CURRENT_TASK" "$meta"
    else
        printf "  $D-- %s %s$R\n" "$CURRENT_TASK_PREFIX" "$CURRENT_TASK"
    end
end

function end_task_fail
    set -l meta "$argv[1]"
    kill_spinner
    clear_line
    if test -n "$meta"
        printf "  %s!!%s %s %s  %s%s%s\n" $RED $R "$CURRENT_TASK_PREFIX" "$CURRENT_TASK" $D "$meta" $R
    else
        printf "  %s!!%s %s %s\n" $RED $R "$CURRENT_TASK_PREFIX" "$CURRENT_TASK"
    end
end

function run_quiet
    if test $DRY_RUN -eq 1
        return 0
    end
    $argv &>/dev/null
    return $status
end

function sudo_quiet
    if test $DRY_RUN -eq 1
        return 0
    end
    sudo $argv &>/dev/null
    return $status
end

function format_bytes
    set -l bytes $argv[1]
    if test -z "$bytes"
        set bytes 0
    end
    if test $bytes -ge 1073741824
        printf "%.1f GB" (math "$bytes / 1073741824")
    else if test $bytes -ge 1048576
        printf "%.1f MB" (math "$bytes / 1048576")
    else if test $bytes -ge 1024
        printf "%.1f KB" (math "$bytes / 1024")
    else
        printf "%d B" $bytes
    end
end

function json_escape
    set -l s "$argv[1]"
    set s (string replace -a "\\" "\\\\\\\\" -- "$s")
    set s (string replace -a "\"" "\\\"" -- "$s")
    set s (string replace -a "\n" "\\n" -- "$s")
    printf "%s" "$s"
end

function show_help
    echo
    echo "  $B clean_arch.fish$R - Deep system cleanup for Arch Linux"
    echo
    echo "  $B USAGE$R"
    echo "      clean_arch.fish [options]"
    echo
    echo "  $B OPTIONS$R"
    echo "      -h, --help                  Show this help"
    echo "      -n, --dry-run               Preview without changes"
    echo "      -y, --yes                   Skip confirmation"
    echo "      --profile=NAME              conservative|balanced|aggressive"
    echo "      --config=PATH               Load config file"
    echo "      --report-json=PATH          Write JSON report"
    echo "      --max-delete-gb=N           Stop after freeing N GB"
    echo "      --include-task=TASK         Run only selected task(s)"
    echo "      --exclude-task=TASK         Skip selected task(s)"
    echo "      --no-spinner                Disable spinner UI"
    echo "      --no-notify                 Disable desktop notification"
    echo
    echo "  $B SKIP OPTIONS$R"
    echo "      --no-orphans                Skip orphan packages"
    echo "      --no-caches                 Skip cache cleanup"
    echo "      --no-docker                 Skip Docker cleanup"
    echo "      --no-logs                   Skip log cleanup"
    echo "      --no-temps                  Skip temp files"
    echo "      --no-trash                  Skip trash"
    echo "      --no-extras                 Skip app-specific extras"
    echo
    echo "  $B TASK NAMES$R"
    echo "      orphans pacman yay package_managers docker user_cache app_caches steam_cache"
    echo "      flatpak journal coredumps var_log temps trash zed_node vesktop"
    echo
end

function confirm
    if test $FORCE_YES -eq 1
        return 0
    end
    if test $DRY_RUN -eq 1
        echo "  $MAGENTA DRY-RUN MODE$R - No changes will be made"
        echo
        return 0
    end
    read -P "  Continue with cleanup? [y/N] " answer
    switch $answer
        case y Y yes Yes
            echo
            return 0
        case '*'
            echo
            echo "  Cancelled."
            echo
            return 1
    end
end

function apply_profile
    switch $PROFILE
        case conservative
            set -g JOURNAL_RETENTION "14d"
            set -g TEMP_FILE_AGE 14
            set -g PACMAN_VERSIONS_KEEP 2
            set -g ZED_NODE_VERSIONS_KEEP 2
            set -g DOCKER_PRUNE_ALL 0
        case balanced
            set -g JOURNAL_RETENTION "7d"
            set -g TEMP_FILE_AGE 7
            set -g PACMAN_VERSIONS_KEEP 1
            set -g ZED_NODE_VERSIONS_KEEP 1
            set -g DOCKER_PRUNE_ALL 0
        case aggressive
            set -g JOURNAL_RETENTION "3d"
            set -g TEMP_FILE_AGE 3
            set -g PACMAN_VERSIONS_KEEP 1
            set -g ZED_NODE_VERSIONS_KEEP 1
            set -g DOCKER_PRUNE_ALL 1
        case '*'
            printf "  $RED✗$R Invalid profile: %s\n\n" $PROFILE
            exit 1
    end
end

function load_config
    set -l path "$argv[1]"
    if test -z "$path"
        return
    end
    if not test -r "$path"
        printf "  $RED✗$R Config not readable: %s\n\n" $path
        exit 1
    end
    while read -l raw
        set -l line (string trim -- "$raw")
        if test -z "$line"
            continue
        end
        if string match -qr '^#' -- "$line"
            continue
        end
        if not string match -qr '=' -- "$line"
            continue
        end
        set -l kv (string split -m 1 '=' -- "$line")
        set -l key (string upper (string trim -- "$kv[1]"))
        set -l value (string trim -- "$kv[2]")
        switch $key
            case PROFILE
                set -g PROFILE "$value"
            case JOURNAL_RETENTION TEMP_FILE_AGE PACMAN_VERSIONS_KEEP ZED_NODE_VERSIONS_KEEP DOCKER_PRUNE_ALL MAX_DELETE_GB
                set -g $key "$value"
            case NO_SPINNER FORCE_YES DRY_RUN
                set -g $key "$value"
            case DO_ORPHANS DO_CACHES DO_DOCKER DO_LOGS DO_TEMPS DO_TRASH DO_EXTRAS
                set -g (string lower $key) "$value"
        end
    end <"$path"
end

function get_total_free_kb
    set -l candidates /
    set -a candidates "$HOME"
    test -d /var/lib/docker; and set -a candidates /var/lib/docker
    test -d /tmp; and set -a candidates /tmp
    test -d /var/tmp; and set -a candidates /var/tmp
    for p in $candidates
        df -Pk "$p" 2>/dev/null | awk 'NR==2 {print $1 " " $4}'
    end | sort -u | awk '{sum += $2} END {print sum + 0}'
end

function budget_exceeded
    if test $MAX_DELETE_BYTES -le 0
        return 1
    end
    if test $TOTAL_FREED_BYTES -ge $MAX_DELETE_BYTES
        return 0
    end
    return 1
end

function should_run_task
    set -l task "$argv[1]"
    if test (count $INCLUDE_TASKS) -gt 0
        contains -- "$task" $INCLUDE_TASKS
        or return 1
    end
    if contains -- "$task" $EXCLUDE_TASKS
        return 1
    end
    return 0
end

function append_task_result
    set -l name "$argv[1]"
    set -l task_status "$argv[2]"
    set -l duration "$argv[3]"
    set -l note "$argv[4]"
    set -l freed "$argv[5]"
    set -ga TASK_NAMES "$name"
    set -ga TASK_STATUSES "$task_status"
    set -ga TASK_DURATIONS_MS "$duration"
    set -ga TASK_NOTES "$note"
    set -ga TASK_FREED_BYTES "$freed"
end

function run_task
    set -g TASK_INDEX (math "$TASK_INDEX + 1")
    set -l key "$argv[1]"
    set -l title "$argv[2]"
    set -l fn "$argv[3]"
    set -l enabled "$argv[4]"
    set -g CURRENT_TASK_PREFIX (printf "[%02d/%02d]" $TASK_INDEX $TASK_TOTAL)

    if not should_run_task "$key"
        set -g CURRENT_TASK "$title"
        end_task_skip
        append_task_result "$key" "skip" 0 "filtered by include/exclude" 0
        return
    end

    if test $enabled -eq 0
        set -g CURRENT_TASK "$title"
        end_task_skip
        append_task_result "$key" "skip" 0 "disabled by flags/config" 0
        return
    end

    if test $STOP_FOR_BUDGET -eq 1
        set -g CURRENT_TASK "$title"
        end_task_skip
        append_task_result "$key" "skip" 0 "stopped by max-delete budget" 0
        return
    end

    set -l before_kb (get_total_free_kb)
    set -l t0_ms (date +%s%3N)
    start_task "$title"
    $fn
    set -l rc $status
    set -l t1_ms (date +%s%3N)
    set -l duration_ms (math "$t1_ms - $t0_ms")
    set -l after_kb (get_total_free_kb)
    set -l freed_kb (math "$after_kb - $before_kb")
    test $freed_kb -lt 0; and set freed_kb 0
    set -l freed_bytes (math "$freed_kb * 1024")
    if test $DRY_RUN -eq 1
        set freed_bytes 0
    end
    switch $rc
        case 0
            set -l meta (fmt_duration_ms $duration_ms)
            end_task_ok "$meta"
            append_task_result "$key" "ok" $duration_ms "" $freed_bytes
            set -g TOTAL_FREED_BYTES (math "$TOTAL_FREED_BYTES + $freed_bytes")
        case 10
            end_task_skip (fmt_duration_ms $duration_ms)
            append_task_result "$key" "skip" $duration_ms "not applicable on this system" 0
        case '*'
            end_task_fail (fmt_duration_ms $duration_ms)
            append_task_result "$key" "fail" $duration_ms "command failed" 0
    end

    if budget_exceeded
        set -g STOP_FOR_BUDGET 1
    end
end

function count_status
    set -l target "$argv[1]"
    set -l n 0
    for s in $TASK_STATUSES
        if test "$s" = "$target"
            set n (math "$n + 1")
        end
    end
    echo $n
end

function ui_task_table
    set -l w (ui_width)
    set -l inner (math "$w - 2")
    set -l n (count $TASK_NAMES)
    if test $n -eq 0
        return
    end
    printf "  %s╭─%s%s╮%s\n" $D " Task report " (string repeat -n (math "$inner - 15") "─") $R
    printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "TASK                 STATUS      FREED       TIME" (math "$inner - 1")) $D $R
    printf "  %s├%s┤%s\n" $D (string repeat -n $inner "─") $R
    for i in (seq 1 $n)
        set -l name "$TASK_NAMES[$i]"
        set -l task_status "$TASK_STATUSES[$i]"
        set -l freed (format_bytes "$TASK_FREED_BYTES[$i]")
        set -l dur (fmt_duration_ms "$TASK_DURATIONS_MS[$i]")
        set -l row (printf "%-20s %-10s %10s   %s" "$name" "$task_status" "$freed" "$dur")
        set -l color $R
        switch $task_status
            case ok
                set color $GREEN
            case fail
                set color $RED
            case skip
                set color $D
        end
        printf "  %s│%s %s%s│%s\n" $D $color (pad_plain "$row" (math "$inner - 1")) $D $R
    end
    printf "  %s╰%s╯%s\n" $D (string repeat -n $inner "─") $R
end

function send_desktop_notification
    if test $NO_NOTIFY -eq 1
        return
    end
    if not type -q notify-send
        return
    end

    set -l duration_s "$argv[1]"
    set -l ok_count (count_status ok)
    set -l skip_count (count_status skip)
    set -l fail_count (count_status fail)
    set -l freed_h (format_bytes $TOTAL_FREED_BYTES)

    set -l title "Clean Arch completed"
    set -l urgency normal
    if test $DRY_RUN -eq 1
        set title "Clean Arch dry-run completed"
    end
    if test $fail_count -gt 0
        set title "Clean Arch completed with failures"
        set urgency critical
    end

    set -l body "Freed: $freed_h | Duration: "$duration_s"s | ok:$ok_count skip:$skip_count fail:$fail_count"
    if test $STOP_FOR_BUDGET -eq 1
        set body "$body | budget reached"
    end

    notify-send -u "$urgency" "$title" "$body" >/dev/null 2>&1
end

function write_json_report
    if test -z "$REPORT_JSON_PATH"
        return
    end
    set -l report_dir (dirname "$REPORT_JSON_PATH")
    if not test -d "$report_dir"
        command mkdir -p "$report_dir" 2>/dev/null
    end

    set -l started_at "$argv[1]"
    set -l ended_at "$argv[2]"
    set -l duration_s "$argv[3]"

    begin
        printf "{\n"
        printf "  \"profile\": \"%s\",\n" (json_escape "$PROFILE")
        printf "  \"dry_run\": %s,\n" (test $DRY_RUN -eq 1; and echo "true"; or echo "false")
        printf "  \"started_at_epoch\": %s,\n" $started_at
        printf "  \"ended_at_epoch\": %s,\n" $ended_at
        printf "  \"duration_seconds\": %s,\n" $duration_s
        printf "  \"total_freed_bytes\": %s,\n" $TOTAL_FREED_BYTES
        printf "  \"budget_stop\": %s,\n" (test $STOP_FOR_BUDGET -eq 1; and echo "true"; or echo "false")
        printf "  \"tasks\": [\n"
        set -l count_tasks (count $TASK_NAMES)
        for i in (seq 1 $count_tasks)
            set -l comma ","
            if test $i -eq $count_tasks
                set comma ""
            end
            set -l task_name "$TASK_NAMES[$i]"
            set -l task_status "$TASK_STATUSES[$i]"
            set -l task_duration "$TASK_DURATIONS_MS[$i]"
            set -l task_freed "$TASK_FREED_BYTES[$i]"
            set -l task_note "$TASK_NOTES[$i]"
            set -l esc_name (json_escape "$task_name")
            set -l esc_status (json_escape "$task_status")
            set -l esc_note (json_escape "$task_note")
            printf "    {\"name\":\"%s\",\"status\":\"%s\",\"duration_ms\":%s,\"freed_bytes\":%s,\"note\":\"%s\"}%s\n" \
                "$esc_name" \
                "$esc_status" \
                "$task_duration" \
                "$task_freed" \
                "$esc_note" \
                "$comma"
        end
        printf "  ]\n"
        printf "}\n"
    end >"$REPORT_JSON_PATH"
end

# Task functions: 0=ok, 10=skip, other=fail.
function clean_orphans
    set -l orphans (pacman -Qdtq 2>/dev/null)
    if test (count $orphans) -eq 0
        return 0
    end
    sudo_quiet pacman -Rns --noconfirm $orphans
    return $status
end

function clean_pacman
    if type -q paccache
        set -l ok 1
        sudo_quiet paccache -r -k$PACMAN_VERSIONS_KEEP; or set ok 0
        sudo_quiet paccache -ru -k$PACMAN_VERSIONS_KEEP; or set ok 0
        test $ok -eq 1; and return 0; or return 1
    end
    sudo_quiet pacman -Sc --noconfirm
    return $status
end

function clean_yay
    if not type -q yay
        return 10
    end
    set -l ok 1
    run_quiet yay -Yc --noconfirm; or set ok 0
    run_quiet yay -Sc --noconfirm; or set ok 0
    test $ok -eq 1; and return 0; or return 1
end

function clean_package_managers
    set -l touched 0
    set -l ok 1

    if type -q npm
        set touched 1
        run_quiet npm cache clean --force; or set ok 0
    end
    if type -q pnpm
        set touched 1
        run_quiet pnpm store prune; or set ok 0
    end
    if type -q yarn
        set touched 1
        run_quiet yarn cache clean --all; or run_quiet yarn cache clean; or set ok 0
    end
    if type -q pip
        set touched 1
        run_quiet pip cache purge; or set ok 0
    end
    if type -q poetry
        set touched 1
        for cache_name in (poetry cache list 2>/dev/null | awk '{print $1}')
            run_quiet poetry cache clear --all $cache_name; or true
        end
    end
    if type -q uv
        set touched 1
        run_quiet uv cache clean; or set ok 0
    end
    if type -q bun
        set touched 1
        run_quiet bun pm cache rm; or true
    end
    if type -q go
        set touched 1
        run_quiet go clean -cache -testcache -fuzzcache; or set ok 0
        run_quiet go clean -modcache; or true
    end
    if type -q cargo-cache
        set touched 1
        run_quiet cargo-cache --autoclean; or set ok 0
    else
        if test $DRY_RUN -eq 0
            for d in "$HOME/.cargo/registry/cache" "$HOME/.cargo/registry/src" "$HOME/.cargo/git/checkouts" "$HOME/.cargo/git/db"
                if test -e "$d"
                    set touched 1
                    command rm -rf "$d" 2>/dev/null; or set ok 0
                end
            end
        else if test -d "$HOME/.cargo"
            set touched 1
        end
    end
    if type -q composer
        set touched 1
        run_quiet composer clear-cache; or true
    end

    if test $touched -eq 0
        return 10
    end
    test $ok -eq 1; and return 0; or return 1
end

function clean_docker
    if not type -q docker
        return 10
    end
    if test $DRY_RUN -eq 1
        return 0
    end
    if not sudo docker info &>/dev/null
        return 10
    end
    if test $DOCKER_PRUNE_ALL -eq 1
        sudo_quiet docker system prune -a -f
    else
        sudo_quiet docker system prune -f
    end
    return $status
end

function delete_path
    set -l path "$argv[1]"
    if test -z "$path"
        return 0
    end
    if test -e "$path"
        if test $DRY_RUN -eq 0
            command rm -rf -- "$path" 2>/dev/null
            return $status
        end
    end
    return 0
end

function clean_user_cache
    if not test -d "$HOME/.cache"
        return 10
    end

    set -l ok 1
    set -l safe_to_delete \
        thumbnails \
        yay \
        paru \
        pip \
        yarn \
        pnpm-store \
        electron \
        '@aspect_rules_js' \
        node \
        node-gyp \
        deno \
        go-build \
        mesa_shader_cache \
        mesa_shader_cache_db \
        fontconfig \
        bazel \
        typescript \
        pre-commit \
        pypoetry \
        uv \
        vite \
        eslint \
        prettier \
        nvim/luac \
        jdtls \
        jdtls-workspace

    for dir in $safe_to_delete
        delete_path "$HOME/.cache/$dir"; or set ok 0
    end

    # Browser cache directories only. This intentionally avoids Cookies,
    # Local Storage, IndexedDB, Login Data, Preferences, extensions and profiles.
    set -l browser_cache_dirs \
        'Google/Chrome/*/Cache' \
        'Google/Chrome/*/Code Cache' \
        'Google/Chrome/*/GPUCache' \
        'BraveSoftware/Brave-Browser/*/Cache' \
        'BraveSoftware/Brave-Browser/*/Code Cache' \
        'BraveSoftware/Brave-Browser/*/GPUCache' \
        'chromium/*/Cache' \
        'chromium/*/Code Cache' \
        'chromium/*/GPUCache' \
        'mozilla/firefox/*/cache2' \
        'mozilla/firefox/*/startupCache'

    if test $DRY_RUN -eq 0
        for pattern in $browser_cache_dirs
            for match in $HOME/.cache/$pattern
                if test -e "$match"
                    command rm -rf -- "$match" 2>/dev/null; or set ok 0
                end
            end
        end
    end

    test $ok -eq 1; and return 0; or return 1
end

function clean_electron_cache_root
    set -l root "$argv[1]"
    if not test -d "$root"
        return 10
    end
    set -l ok 1
    set -l cache_names \
        Cache \
        'Code Cache' \
        GPUCache \
        ShaderCache \
        GrShaderCache \
        DawnCache \
        DawnWebGPUCache \
        DawnGraphiteCache \
        component_crx_cache \
        Crashpad \
        'Crash Reports'

    for name in $cache_names
        delete_path "$root/$name"; or set ok 0
        delete_path "$root/Default/$name"; or set ok 0
        delete_path "$root/sessionData/$name"; or set ok 0
    end
    test $ok -eq 1; and return 0; or return 1
end

function clean_app_caches
    set -l touched 0
    set -l ok 1

    # Big user caches observed on this machine. Removing these does not remove
    # app configs/logins because they live outside ~/.cache or in non-cache DBs.
    for p in \
        "$HOME/.cache/spotify" \
        "$HOME/.cache/net.imput.helium" \
        "$HOME/.cache/discord" \
        "$HOME/.cache/vesktop" \
        "$HOME/.cache/obsidian" \
        "$HOME/.cache/zed"
        if test -e "$p"
            set touched 1
            delete_path "$p"; or set ok 0
        end
    end

    for root in \
        "$HOME/.config/net.imput.helium" \
        "$HOME/.config/obsidian" \
        "$HOME/.config/vesktop" \
        "$HOME/.config/discord" \
        "$HOME/.config/discordcanary" \
        "$HOME/.config/Slack" \
        "$HOME/.config/Code" \
        "$HOME/.config/Code - OSS" \
        "$HOME/.config/VSCodium"
        if test -d "$root"
            set touched 1
            clean_electron_cache_root "$root"; or set ok 0
        end
    end

    if test $touched -eq 0
        return 10
    end
    test $ok -eq 1; and return 0; or return 1
end

function clean_steam_cache
    set -l steam "$HOME/.local/share/Steam"
    if not test -d "$steam"
        return 10
    end
    set -l ok 1
    for p in \
        "$steam/appcache/httpcache" \
        "$steam/appcache/librarycache" \
        "$steam/config/htmlcache" \
        "$steam/steamui/cache" \
        "$steam/steamapps/shadercache"
        delete_path "$p"; or set ok 0
    end
    test $ok -eq 1; and return 0; or return 1
end

function clean_flatpak
    if not type -q flatpak
        return 10
    end
    run_quiet flatpak uninstall --unused -y
    return $status
end

function clean_coredumps
    set -l touched 0
    set -l ok 1

    # coredumpctl lists coredumps but does not support vacuum/delete options on
    # this system. The actual files are cache-like crash dumps under these dirs.
    for dir in /var/lib/systemd/coredump /var/lib/coredump
        if test -d "$dir"
            set touched 1
            if test $DRY_RUN -eq 0
                sudo find "$dir" -type f -delete 2>/dev/null; or set ok 0
            end
        end
    end

    if test $touched -eq 0
        return 10
    end
    test $ok -eq 1; and return 0; or return 1
end

function clean_journal
    set -l ok 1
    sudo_quiet journalctl --rotate; or set ok 0
    sudo_quiet journalctl --vacuum-time=$JOURNAL_RETENTION; or set ok 0
    test $ok -eq 1; and return 0; or return 1
end

function clean_var_log
    if test $DRY_RUN -eq 0
        sudo find /var/log -type f -size +1M \
            ! -path "/var/log/journal/*" \
            ! -name "wtmp" ! -name "btmp" ! -name "lastlog" \
            -exec truncate -s 0 {} + 2>/dev/null
        return $status
    end
    return 0
end

function clean_temps
    if test $DRY_RUN -eq 0
        set -l ok 1
        sudo find /tmp -mindepth 1 -mtime +$TEMP_FILE_AGE -exec rm -rf {} + 2>/dev/null; or set ok 0
        sudo find /var/tmp -mindepth 1 -mtime +$TEMP_FILE_AGE -exec rm -rf {} + 2>/dev/null; or set ok 0
        test $ok -eq 1; and return 0; or return 1
    end
    return 0
end

function clean_trash
    set -l trash_dir "$HOME/.local/share/Trash"
    if not test -d "$trash_dir"
        return 10
    end
    if test $DRY_RUN -eq 0
        # Avoid Fish wildcard failures when Trash is empty.
        find "$trash_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null
        return $status
    end
    return 0
end

function clean_zed_node
    set -l zed_node_dir "$HOME/.local/share/zed/node"
    if not test -d "$zed_node_dir"
        return 10
    end
    set -l versions (ls -1 "$zed_node_dir" 2>/dev/null | sort -V -r)
    if test (count $versions) -le $ZED_NODE_VERSIONS_KEEP
        return 0
    end
    if test $DRY_RUN -eq 0
        set -l to_delete $versions[(math $ZED_NODE_VERSIONS_KEEP + 1)..-1]
        for version in $to_delete
            command rm -rf "$zed_node_dir/$version" 2>/dev/null
        end
    end
    return 0
end

function clean_vesktop
    set -l vesktop_root "$HOME/.config/vesktop"
    if not test -d "$vesktop_root"
        return 10
    end
    clean_electron_cache_root "$vesktop_root"
    return $status
end

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

argparse 'h/help' 'n/dry-run' 'y/yes' \
    'profile=' 'config=' 'report-json=' 'max-delete-gb=' \
    'include-task=+' 'exclude-task=+' \
    'no-spinner' 'no-notify' \
    'no-orphans' 'no-caches' 'no-docker' 'no-logs' 'no-temps' 'no-trash' 'no-extras' \
    -- $argv
or begin
    show_help
    exit 1
end

if set -q _flag_help
    show_help
    exit 0
end

set -q _flag_dry_run; and set -g DRY_RUN 1
set -q _flag_yes; and set -g FORCE_YES 1
set -q _flag_no_spinner; and set -g NO_SPINNER 1
set -q _flag_no_notify; and set -g NO_NOTIFY 1
set -q _flag_profile; and set -g PROFILE "$_flag_profile"
set -q _flag_report_json; and set -g REPORT_JSON_PATH "$_flag_report_json"
set -q _flag_include_task; and set -g INCLUDE_TASKS $_flag_include_task
set -q _flag_exclude_task; and set -g EXCLUDE_TASKS $_flag_exclude_task

set -q _flag_no_orphans; and set do_orphans 0
set -q _flag_no_caches; and set do_caches 0
set -q _flag_no_docker; and set do_docker 0
set -q _flag_no_logs; and set do_logs 0
set -q _flag_no_temps; and set do_temps 0
set -q _flag_no_trash; and set do_trash 0
set -q _flag_no_extras; and set do_extras 0

set -q _flag_config; and load_config "$_flag_config"
apply_profile

if set -q _flag_max_delete_gb
    set -g MAX_DELETE_GB "$_flag_max_delete_gb"
end
if test "$MAX_DELETE_GB" != 0
    set -g MAX_DELETE_BYTES (math "$MAX_DELETE_GB * 1073741824")
end

ui_banner
ui_settings_panel
ui_safety_panel
echo

acquire_lock; or exit 1

if not confirm
    cleanup_resources
    exit 0
end

if test $DRY_RUN -eq 0
    printf "  %s Authenticating..." $D
    if not sudo -v 2>/dev/null
        clear_line
        printf "  %s!!%s Failed to acquire sudo privileges.\n\n" $RED $R
        cleanup_resources
        exit 1
    end
    clear_line
    printf "  %sOK%s Authenticated\n" $GREEN $R
    fish -c 'while true; sudo -n true 2>/dev/null; sleep 50; end' &
    set -g SUDO_KEEPALIVE_PID $last_pid
end

set -l start_time (date +%s)
set -g START_FREE_KB (get_total_free_kb)

run_task orphans "Removing orphan packages" clean_orphans $do_orphans
run_task pacman "Cleaning pacman cache" clean_pacman $do_caches
run_task yay "Cleaning AUR cache" clean_yay $do_caches
run_task package_managers "Cleaning package managers" clean_package_managers $do_caches
run_task docker "Pruning Docker" clean_docker $do_docker
run_task user_cache "Cleaning generic ~/.cache" clean_user_cache $do_caches
run_task app_caches "Cleaning app/browser caches" clean_app_caches $do_caches
run_task steam_cache "Cleaning Steam caches" clean_steam_cache $do_caches
run_task flatpak "Removing unused Flatpak runtimes" clean_flatpak $do_caches
run_task journal "Vacuuming journal logs" clean_journal $do_logs
run_task coredumps "Cleaning system coredumps" clean_coredumps $do_logs
run_task var_log "Truncating /var/log" clean_var_log $do_logs
run_task temps "Cleaning temp files" clean_temps $do_temps
run_task trash "Emptying trash" clean_trash $do_trash
run_task zed_node "Cleaning Zed old node versions" clean_zed_node $do_extras
run_task vesktop "Cleaning Vesktop cache" clean_vesktop $do_extras

set -l end_time (date +%s)
set -g END_FREE_KB (get_total_free_kb)
set -l duration (math "$end_time - $start_time")
set -l delta_kb (math "$END_FREE_KB - $START_FREE_KB")
test $delta_kb -lt 0; and set delta_kb 0
set -l delta_bytes (math "$delta_kb * 1024")
if test $DRY_RUN -eq 1
    set -g TOTAL_FREED_BYTES 0
else
    set -g TOTAL_FREED_BYTES $delta_bytes
end

echo
ui_task_table
set -l ok_count (count_status ok)
set -l skip_count (count_status skip)
set -l fail_count (count_status fail)
set -l w (ui_width)
set -l inner (math "$w - 2")
set -l final_bar (progress_bar $TASK_INDEX $TASK_TOTAL 24)
printf "  %s╭─%s%s╮%s\n" $D " Summary " (string repeat -n (math "$inner - 11") "─") $R
printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "Progress: $final_bar" (math "$inner - 1")) $D $R
printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "Results: $ok_count ok   $skip_count skip   $fail_count fail" (math "$inner - 1")) $D $R
printf "  %s│%s %s%s│%s\n" $D $R (pad_plain "Freed: "(format_bytes $TOTAL_FREED_BYTES)"   Duration: "$duration"s" (math "$inner - 1")) $D $R
if test $STOP_FOR_BUDGET -eq 1
    printf "  %s│%s %s%s│%s\n" $D $YELLOW (pad_plain "Stopped after reaching max-delete budget." (math "$inner - 1")) $D $R
end
printf "  %s╰%s╯%s\n" $D (string repeat -n $inner "─") $R
echo

write_json_report $start_time $end_time $duration
send_desktop_notification $duration
cleanup_resources
