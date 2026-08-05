-- Keyboard, pointer, touchpad, and per-device input configuration.

hl.config({
    input = {
        kb_layout = "us, latam",
        kb_variant = "intl,",
        follow_mouse = 1,
        accel_profile = "flat",
        sensitivity = 0,
        touchpad = {
            natural_scroll = false,
            disable_while_typing = true,
        },
    },

    gestures = {
        workspace_swipe_distance = 250,
        workspace_swipe_cancel_ratio = 0.4,
        workspace_swipe_direction_lock = true,
    },
})

-- Three-finger horizontal swipes follow the workspace animation interactively.
hl.gesture({
    fingers = 3,
    direction = "horizontal",
    action = "workspace",
})
