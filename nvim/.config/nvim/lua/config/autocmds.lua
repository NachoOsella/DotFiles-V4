-- Definir la función una vez
local function sync_float_bg()
    local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
    local bg = normal.bg
    if not bg then
        return
    end

    -- Floats estándar
    vim.api.nvim_set_hl(0, "NormalFloat", { bg = bg })
    vim.api.nvim_set_hl(0, "FloatBorder", { bg = bg })
    vim.api.nvim_set_hl(0, "FloatTitle", { bg = bg })
    vim.api.nvim_set_hl(0, "FloatFooter", { bg = bg })

    -- Snacks.nvim
    vim.api.nvim_set_hl(0, "SnacksNormal", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksNormalNC", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksWinBar", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksWinBarNC", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksTitle", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksFooter", { bg = bg })
    vim.api.nvim_set_hl(0, "SnacksWinSeparator", { bg = bg })
end

-- Ejecutar cuando cambie el colorscheme
vim.api.nvim_create_autocmd("ColorScheme", {
    callback = sync_float_bg,
})

-- Ejecutar AHORA (al cargar la config)
-- Usar vim.defer_fn para asegurar que el colorscheme ya se aplicó
vim.defer_fn(sync_float_bg, 0)

-- Cierra buffers de terminal al salir de Neovim

-- Mata jobs de terminal y borra buffers de terminal al salir
vim.api.nvim_create_autocmd("QuitPre", {
    callback = function()
        local buffers = vim.api.nvim_list_bufs()
        for _, buf in ipairs(buffers) do
            if vim.api.nvim_buf_is_valid(buf) then
                local buftype = vim.bo[buf].buftype
                if buftype == "terminal" then
                    local chan = vim.bo[buf].channel
                    if chan and chan > 0 then
                        vim.fn.jobstop(chan)
                    end
                    vim.api.nvim_buf_delete(buf, { force = true })
                end
            end
        end
    end,
})
