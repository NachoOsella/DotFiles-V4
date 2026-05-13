-- Shared command names used by binds and startup modules.
-- Returning a table avoids global variables and keeps dependencies explicit.

return {
    terminal = "kitty",
    file_manager = "kitty -e yazi",
    menu = "rofi -show drun",
    main_mod = "SUPER",
}
