return {
    "MeanderingProgrammer/render-markdown.nvim", -- Make Markdown buffers look beautiful
    ft = { "markdown", "copilot-chat" },
    opts = {
        render_modes = { "n", "c", "t" },
        sign = {
            enabled = false, -- Turn off in the status column
        },
    },
}
