local function sync_float_bg()
    local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
    local bg = normal.bg
    if not bg then
        return
    end

    vim.api.nvim_set_hl(0, "NormalFloat", { bg = bg })
    vim.api.nvim_set_hl(0, "FloatBorder", { bg = bg })
    vim.api.nvim_set_hl(0, "FloatTitle", { bg = bg })
    vim.api.nvim_set_hl(0, "FloatFooter", { bg = bg })

    vim.api.nvim_set_hl(0, "SnacksNormal", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksNormalNC", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksWinBar", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksWinBarNC", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksTitle", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksFooter", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksWinSeparator", { bg = bg })
end

local function sync_neotree_highlights()
    local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
    local normal_nc = vim.api.nvim_get_hl(0, { name = "NormalNC", link = false })
    local end_of_buffer = vim.api.nvim_get_hl(0, { name = "EndOfBuffer", link = false })
    local sign_column = vim.api.nvim_get_hl(0, { name = "SignColumn", link = false })

    vim.api.nvim_set_hl(0, "NeoTreeNormal", { fg = normal.fg, bg = normal.bg })
    vim.api.nvim_set_hl(0, "NeoTreeNormalNC", {
        fg = normal_nc.fg or normal.fg,
        bg = normal.bg,
    })
    vim.api.nvim_set_hl(0, "NeoTreeEndOfBuffer", {
        fg = end_of_buffer.fg,
        bg = normal.bg,
    })
    vim.api.nvim_set_hl(0, "NeoTreeSignColumn", {
        fg = sign_column.fg or normal.fg,
        bg = sign_column.bg or normal.bg,
    })
    vim.api.nvim_set_hl(0, "NeoTreeWinSeparator", { link = "WinSeparator" })
end

local float_group = vim.api.nvim_create_augroup("user_float_background", { clear = true })
vim.api.nvim_create_autocmd("ColorScheme", {
    group = float_group,
    callback = sync_float_bg,
})
vim.defer_fn(sync_float_bg, 0)

local neotree_group = vim.api.nvim_create_augroup("user_neotree_highlights", { clear = true })
vim.api.nvim_create_autocmd("ColorScheme", {
    group = neotree_group,
    callback = sync_neotree_highlights,
})
vim.api.nvim_create_autocmd({ "FileType", "BufEnter", "BufWinEnter", "WinEnter" }, {
    group = neotree_group,
    pattern = "neo-tree",
    callback = sync_neotree_highlights,
})
vim.api.nvim_create_autocmd("VimEnter", {
    group = neotree_group,
    callback = function()
        vim.defer_fn(sync_neotree_highlights, 50)
    end,
})
vim.defer_fn(sync_neotree_highlights, 0)

local terminal_group = vim.api.nvim_create_augroup("user_terminal_cleanup", { clear = true })
vim.api.nvim_create_autocmd("QuitPre", {
    group = terminal_group,
    callback = function()
        for _, buf in ipairs(vim.api.nvim_list_bufs()) do
            if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].buftype == "terminal" then
                local chan = vim.bo[buf].channel
                if chan and chan > 0 then
                    vim.fn.jobstop(chan)
                end
                vim.api.nvim_buf_delete(buf, { force = true })
            end
        end
    end,
})
