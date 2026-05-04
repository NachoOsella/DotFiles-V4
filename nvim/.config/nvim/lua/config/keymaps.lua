vim.keymap.set({ "n", "t" }, "<C-\\>", function()
    Snacks.terminal.focus(nil, {
        cwd = LazyVim.root(),
        win = {
            position = "right",
            width = 0.4,
        },
    })
end, { desc = "Terminal Vertical" })
