-- Keyboard, pointer, touchpad, and per-device input configuration.

hl.config({
    input = {
        kb_layout = "us, latam",
        kb_variant = "intl",
        follow_mouse = 1,
        accel_profile = "flat",
        sensitivity = 0,
        touchpad = {
            natural_scroll = false,
        },
    },
})

hl.device({
    name = "epic-mouse-v1",
    sensitivity = -0.5,
})
